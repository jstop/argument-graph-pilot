// HTTP face of the issuer.
//   public:    GET /oobi/<schema SAID>   the schema, fetched by wallets and KERIA agents
//              GET /healthz
//              GET /registry                      {issuer, registry, credentials:[{said, status}]}
//              GET /registry/<credential SAID>.cesr   CESR export for the independent verifier
//              GET /connect                       wallet onboarding
//   operator:  everything else, behind HTTP Basic (user "operator", password OPERATOR_TOKEN)
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { countSignatures } from "@pilot/common";
import { CheckpointError, Issuer, RevokeError, type Session } from "./core";
import { HandleError, parseSessionInput } from "./handle";
import { operatorPage } from "./ui";

export interface ServerOptions {
  issuer: Issuer;
  operatorToken: string;
  /** KERIA URLs as a phone reaches them; shown as the onboarding QR and served at /connect. */
  wallet?: { bootUrl: string; connectUrl: string };
}

export function buildServer({ issuer, operatorToken, wallet }: ServerOptions): Server {
  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      json(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    if (req.method === "GET" && path === `/oobi/${issuer.schemaSaid}`) {
      res.writeHead(200, { "Content-Type": "application/schema+json", "Access-Control-Allow-Origin": "*" });
      res.end(issuer.schemaJson());
      return;
    }
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, issuer: issuer.aid || null });
    // The wallet's onboarding: scan the boot URL, then GET <boot host>/connect
    // for the admin URL (agent.ts discoverConnectUrl). KERIA itself does not
    // serve this; in cloud mode traefik routes keria-boot.<domain>/connect here.
    if (req.method === "GET" && path === "/connect" && wallet) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ connectUrl: wallet.connectUrl }));
      return;
    }

    // Public on purpose: this is what anyone needs to check a membership
    // without trusting us or the relying party. No handles, no member AIDs
    // in the listing; the export contains what the credential contains.
    if (req.method === "GET" && path === "/registry") {
      if (!issuer.oobi) return json(res, 503, { error: "issuer is still initialising" });
      const credentials = (await issuer.members()).map(({ said, status }) => ({ said, status }));
      return json(res, 200, { issuer: issuer.aid, registry: issuer.registry, credentials }, { "Access-Control-Allow-Origin": "*" });
    }
    const reg = /^\/registry\/([A-Za-z0-9_-]{44})\.cesr$/.exec(path);
    if (req.method === "GET" && reg) {
      if (!issuer.oobi) return json(res, 503, { error: "issuer is still initialising" });
      const cesr = await issuer.exportCesr(reg[1]);
      if (cesr === undefined) return json(res, 404, { error: "no such credential issued here" });
      res.writeHead(200, { "Content-Type": "application/json+cesr", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      res.end(cesr);
      return;
    }

    if (!authorized(req, operatorToken)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="issuer operator"' });
      res.end("operator credentials required");
      return;
    }

    if (!issuer.oobi) return json(res, 503, { error: "issuer is still initialising" });

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(operatorPage());
      return;
    }
    if (req.method === "GET" && path === "/api/issuer") {
      return json(res, 200, {
        ...(await issuer.keyState()), registry: issuer.registry, schema: issuer.schemaSaid, oobi: issuer.oobi,
        walletBootUrl: wallet?.bootUrl,
        walletQrSvg: wallet ? await QRCode.toString(wallet.bootUrl, { type: "svg", margin: 1 }) : undefined,
      });
    }
    if (req.method === "GET" && path === "/api/issuer/inception") {
      return json(res, 200, describeInception(await issuer.inceptionEvent()));
    }
    if (req.method === "POST" && path === "/api/sessions") {
      try {
        const session = issuer.createSession(parseSessionInput(JSON.parse(await body(req))));
        return json(res, 201, await view(session));
      } catch (e) {
        if (e instanceof HandleError || e instanceof SyntaxError) return json(res, 400, { error: e.message });
        throw e;
      }
    }
    const m = /^\/api\/sessions\/([0-9a-f]{32})$/.exec(path);
    if (req.method === "GET" && m) {
      const session = issuer.session(m[1]);
      return session ? json(res, 200, await view(session)) : json(res, 404, { error: "no such session" });
    }
    if (req.method === "GET" && path === "/api/members") return json(res, 200, await issuer.members());
    if (req.method === "POST" && path === "/api/checkpoint") {
      try {
        return json(res, 200, await issuer.checkpointCurrentHead());
      } catch (e) {
        if (e instanceof CheckpointError) return json(res, 502, { error: e.message });
        throw e;
      }
    }
    const rev = /^\/api\/members\/([A-Za-z0-9_-]{44})\/revoke$/.exec(path);
    if (req.method === "POST" && rev) {
      try {
        const text = await body(req);
        const opts = text.trim() === "" ? {} : JSON.parse(text);
        if (typeof opts !== "object" || opts === null || Object.keys(opts).some((k) => k !== "noCheckpoint") ||
          ("noCheckpoint" in opts && typeof opts.noCheckpoint !== "boolean")) {
          return json(res, 400, { error: 'body must be empty, {} or {"noCheckpoint":true}' });
        }
        const done = await issuer.revokeAtCurrentHead(rev[1], { noCheckpoint: opts.noCheckpoint === true }, (m) => console.warn(`[issuer] ${m}`));
        return json(res, 200, { revoked: rev[1], ...done });
      } catch (e) {
        if (e instanceof SyntaxError) return json(res, 400, { error: e.message });
        if (e instanceof CheckpointError) return json(res, 502, { error: e.message });
        if (e instanceof RevokeError) return json(res, /already/.test(e.message) ? 409 : 404, { error: e.message });
        throw e;
      }
    }
    json(res, 404, { error: "not found" });
  }

  async function view(session: Session) {
    const waiting = session.state === "waiting-for-scan";
    const qrUrl = waiting ? issuer.qrUrl(session) : undefined;
    return {
      ...session,
      qrUrl,
      qrSvg: qrUrl ? await QRCode.toString(qrUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : undefined,
    };
  }
}

/** The inception event plus a count of what is attached to it, for the operator page. */
export function describeInception(event: { ked: Record<string, unknown>; atc: string }) {
  return { event: event.ked, ...countSignatures(event.atc), attachment: event.atc };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
  const given = Buffer.from(rest.join(":"));
  const expected = Buffer.from(token);
  return user === "operator" && given.length === expected.length && timingSafeEqual(given, expected);
}

function body(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8"); // handles may be non-ASCII; never split a character across chunks
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new SyntaxError("request body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}
