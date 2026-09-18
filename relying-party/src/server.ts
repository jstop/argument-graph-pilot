// HTTP face of the relying party. Everything is public and, except for
// posting, read-only: there are no accounts. A session URL contains a
// random id that only the browser that created it knows.
//   GET  /                         the argument: claims, responses, strengths
//   GET  /entry/<SAID>[.json]      one signed entry: text, arithmetic, signature (or the raw record)
//   GET  /kel/<AID>[.json]         a key event log as our agent holds it
//   GET  /log.json  /log/head      the raw log; its current head {n, d} (the issuer checkpoints this)
//   GET  /export.json              everything the independent verifier needs
//   GET  /decisions[.json]         every gate decision, accept and reject
//   GET  /verify                   how to check all of it without us
//   GET  /start?kind=&target=      new posting session -> /s/<id>
//   GET  /s/<id>                   the session page (QR, status, text box)
//   GET  /api/sessions/<id>        session state (polled by the page)
//   POST /api/sessions/<id>/entry  {"kind","text","target"}
//   GET  /oobi/<schema SAID>       the schema, fetched by wallets when we ask for a presentation
//   GET  /healthz
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { EntryError, RelyingParty, type Session } from "./core";
import { decisionsPage, entryPage, graphPage, kelPage, sessionPage, verifyPage } from "./ui";

const SAID = "[A-Za-z0-9_-]{44}";

export function buildServer(rp: RelyingParty): Server {
  const intents = new Map<string, { kind: string; target?: string }>();

  return createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); json(res, 500, { error: "internal error" }); });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    const get = req.method === "GET";

    if (get && path === "/healthz") return json(res, 200, { ok: !!rp.gate, operator: rp.aid || null, records: rp.gate?.log.length ?? 0 });
    if (get && path === `/oobi/${rp.config.schemaSaid}`) {
      res.writeHead(200, { "Content-Type": "application/schema+json", "Access-Control-Allow-Origin": "*" });
      res.end(rp.schemaJson());
      return;
    }
    if (!rp.gate) return json(res, 503, { error: "starting" });

    if (get && path === "/") return html(res, graphPage(rp.view(), rp.aid, rp.config.community));
    if (get && path === "/verify") return html(res, verifyPage(rp.config.trustedIssuerAid, rp.config.publicUrl));
    if (get && path === "/log.json") return json(res, 200, rp.gate.log);
    if (get && path === "/log/head") return json(res, 200, { n: rp.gate.head!.n, d: rp.gate.head!.d });
    if (get && path === "/export.json") return json(res, 200, await rp.exportBundle(), true);
    if (get && path === "/decisions") return html(res, decisionsPage(rp.gate.decisions()));
    if (get && path === "/decisions.json") return json(res, 200, rp.gate.decisions());
    if (get && path === "/api/strengths") {
      return json(res, 200, rp.view().nodes.map((n) => ({ n: n.record.n, said: n.record.d, kind: n.record.payload.kind, handle: n.handle,
        strength: n.result?.strength ?? null, display: n.result?.display ?? null, counted: n.result?.counted ?? null, excluded: n.excluded ?? null })));
    }

    const entry = new RegExp(`^/entry/(${SAID})(\\.json)?$`).exec(path);
    if (get && entry) {
      const record = rp.gate.log.find((r) => r.d === entry[1]);
      if (!record) return json(res, 404, { error: "no such entry" });
      if (entry[2] || record.n === 0) return json(res, 200, record, true);
      const view = rp.view();
      return html(res, entryPage(view.byId.get(record.d)!, view, rp.gate.decisions().find((d) => d.record === record.d)));
    }
    const kel = new RegExp(`^/kel/(${SAID})(\\.json)?$`).exec(path);
    if (get && kel) {
      const known = kel[1] === rp.aid || kel[1] === rp.config.trustedIssuerAid || rp.gate.log.some((r) => r.payload.author === kel[1]);
      if (!known) return json(res, 404, { error: "not an identifier that appears in this log" });
      const events = await rp.kel(kel[1]);
      return kel[2] ? json(res, 200, events, true) : html(res, kelPage(kel[1], events));
    }

    if (get && path === "/start") {
      const kind = url.searchParams.get("kind") ?? "claim";
      const target = url.searchParams.get("target") ?? undefined;
      if (!["claim", "support", "attack"].includes(kind)) return json(res, 400, { error: "kind must be claim, support or attack" });
      if (kind !== "claim" && !rp.gate.log.some((r) => r.n > 0 && r.d === target)) return json(res, 400, { error: "no such entry to respond to" });
      const session = rp.createSession();
      intents.set(session.id, { kind, target: kind === "claim" ? undefined : target });
      res.writeHead(303, { Location: `/s/${session.id}?kind=${kind}${kind === "claim" ? "" : `&target=${target}`}` });
      res.end();
      return;
    }
    const sp = /^\/s\/([0-9a-f]{32})$/.exec(path);
    if (get && sp) {
      if (!rp.session(sp[1])) return json(res, 404, { error: "no such session" });
      const intent = intents.get(sp[1]) ?? { kind: url.searchParams.get("kind") ?? "claim", target: url.searchParams.get("target") ?? undefined };
      return html(res, sessionPage(sp[1], intent.kind, intent.target ? rp.view().byId.get(intent.target) : undefined, rp.config.maxTextLength));
    }
    const api = /^\/api\/sessions\/([0-9a-f]{32})(\/entry)?$/.exec(path);
    if (api && get && !api[2]) {
      const session = rp.session(api[1]);
      return session ? json(res, 200, await sessionView(session)) : json(res, 404, { error: "no such session" });
    }
    if (api && req.method === "POST" && api[2]) {
      try {
        const { kind, text, target } = JSON.parse(await body(req));
        return json(res, 200, await sessionView(await rp.requestEntry(api[1], kind, text, target ?? undefined)));
      } catch (e) {
        if (e instanceof EntryError) return json(res, e.status, { error: e.message });
        if (e instanceof SyntaxError) return json(res, 400, { error: e.message });
        throw e;
      }
    }
    json(res, 404, { error: "not found" });
  }

  async function sessionView(session: Session) {
    const qrUrl = session.state === "waiting-for-scan" ? rp.qrUrl(session) : undefined;
    return { ...session, qrUrl, qrSvg: qrUrl ? await QRCode.toString(qrUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : undefined };
  }
}

function body(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk); size += chunk.length;
      if (size > limit) { reject(new SyntaxError("request body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown, pretty = false): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload, null, pretty ? 1 : undefined));
}

function html(res: ServerResponse, page: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}
