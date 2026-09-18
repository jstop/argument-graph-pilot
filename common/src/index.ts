// Helpers shared by the issuer and the relying party. Both are Signify
// clients: their private keys are derived locally from a passcode
// ("bran") and never leave the process. KERIA only ever receives signed
// events and key material encrypted to the client.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import signify, { type Operation, type SignifyClient } from "signify-ts";

const { randomPasscode, ready, SignifyClient: Client, Tier } = signify;

export { JsonStore } from "./store";

export interface KeriaEndpoints {
  /** KERIA admin API (port 3901). Signed requests only. */
  url: string;
  /** KERIA boot API (port 3903). Used once, to create the agent. */
  bootUrl: string;
}

/**
 * Reads the passcode from `path`, creating it (mode 0600) on first run.
 * Whoever holds this file controls the identifier; see DESIGN.md.
 */
export async function loadOrCreateBran(path: string): Promise<{ bran: string; created: boolean }> {
  if (existsSync(path)) {
    return { bran: readFileSync(path, "utf8").trim(), created: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  await ready(); // libsodium must be initialised before it can produce randomness
  const bran = randomPasscode();
  writeFileSync(path, bran + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { bran, created: true };
}

/** Connects to this passcode's KERIA agent, booting it if it does not exist yet. */
export async function connect(endpoints: KeriaEndpoints, bran: string): Promise<SignifyClient> {
  await ready();
  const client = new Client(endpoints.url, bran, Tier.low, endpoints.bootUrl);
  try {
    await client.connect();
  } catch (e) {
    if (!(e instanceof Error) || !/agent does not exist/i.test(e.message)) throw e;
    const res = await client.boot();
    if (!res.ok) throw new Error(`KERIA boot failed: ${res.status} ${await res.text()}`);
    await client.connect();
  }
  return client;
}

/** Polls a KERIA long-running operation until done. Throws on error or timeout. */
export async function waitOp<T = unknown>(
  client: SignifyClient,
  op: Operation<T>,
  timeoutMs = 60_000
): Promise<Operation<T>> {
  const deadline = Date.now() + timeoutMs;
  let current = op;
  while (!current.done) {
    if (Date.now() > deadline) throw new Error(`operation ${op.name} timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
    current = (await client.operations().get(op.name)) as Operation<T>;
  }
  if (current.error) {
    throw new Error(`operation ${op.name} failed: ${JSON.stringify(current.error)}`);
  }
  await client.operations().delete(op.name).catch(() => undefined);
  return current;
}

export async function resolveOobi(client: SignifyClient, oobi: string, alias?: string): Promise<void> {
  try {
    await waitOp(client, await client.oobis().resolve(oobi, alias));
  } catch (e) {
    throw new Error(`could not resolve OOBI ${oobi}: ${e instanceof Error ? e.message : e}`);
  }
}

/** OOBI through which others discover `name` via its KERIA agent. */
export async function agentOobi(client: SignifyClient, name: string): Promise<string> {
  const res = await client.oobis().get(name, "agent");
  const oobi = res.oobis?.[0];
  if (!oobi) throw new Error(`no agent OOBI for ${name}; is the agent end role set?`);
  return oobi;
}

export function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing required environment variable ${name}`);
  return v;
}

/**
 * WORKAROUND for a bug in Veridian's KERIA fork (bca7acc,
 * keria/core/authing.py). Requests reach KERIA inside an encrypted
 * tunnel (ESSR) as literal HTTP text. When KERIA rebuilds the request it
 * sets CONTENT_LENGTH to the body's length in *characters* but feeds the
 * parser UTF-8 *bytes*, and it re-splits the body with splitlines(). So
 * any non-ASCII character in any request (a name, a claim) truncates the
 * body and KERIA answers "400 Invalid JSON"; Unicode line separators
 * would be rewritten.
 *
 * We do not modify KERIA. Instead every JSON body we send is made pure
 * ASCII by backslash-u escaping. KERIA parses it back to the identical
 * strings, so SAIDs and signatures (computed over the UTF-8 form) are
 * unaffected. The tunnel seals the body before `fetch` is called, so the
 * only seam is where signify-ts constructs the inner `Request`.
 * Call once at startup. See DESIGN.md, "Bugs we route around".
 */
export function installAsciiJsonBodies(): void {
  const Base = globalThis.Request;
  if ((Base as any).__asciiJsonBodies) return;
  class AsciiBodyRequest extends Base {
    static __asciiJsonBodies = true;
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (
        typeof init?.body === "string" &&
        init.headers instanceof Headers &&
        init.headers.get("Content-Type") === "application/json"
      ) {
        const ascii = asciiJson(init.body);
        init.headers.set("Content-Length", String(ascii.length));
        init = { ...init, body: ascii };
      }
      super(input, init);
    }
  }
  globalThis.Request = AsciiBodyRequest as typeof Request;
}

/** JSON text in, equivalent JSON text out, every non-ASCII code unit escaped. */
export function asciiJson(json: string): string {
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x7f ? json[i] : "\\u" + code.toString(16).padStart(4, "0");
  }
  return out;
}

/**
 * Witness AIDs from the KERIA operator's configured iurls: the same source
 * the wallet uses (identifierService.ts getAvailableWitnesses).
 */
export async function witnessAidsFromAgentConfig(client: SignifyClient): Promise<string[]> {
  const config = await client.config().get();
  const aids = new Set<string>();
  for (const iurl of config.iurls ?? []) {
    // Exactly the wallet's rule: only OOBIs marked ?role=witness count.
    if (new URL(iurl).searchParams.get("role") !== "witness") continue;
    const m = /\/oobi\/([A-Za-z0-9_-]{44})\/controller/.exec(iurl);
    if (m) aids.add(m[1]);
  }
  return [...aids];
}

/** Same ladder the wallet uses; below six witnesses the wallet refuses to create identifiers. */
export function toadFor(witnessCount: number): number {
  if (witnessCount >= 12) return 8;
  if (witnessCount >= 10) return 7;
  if (witnessCount >= 9) return 6;
  if (witnessCount >= 7) return 5;
  if (witnessCount >= 6) return 4;
  throw new Error(`the wallet needs at least 6 witnesses configured in KERIA, found ${witnessCount}`);
}

/**
 * Counts what is attached to a key event: the controller's own
 * signatures and the witnesses' receipts. Counting only. Verifying them
 * is KERIA's job; an event KERIA returns from a remote KEL has already
 * passed signature and witness-threshold checks.
 *
 * Walks the CESR counters in order rather than searching for them: "-A"
 * and "-B" are also perfectly ordinary base64 inside a signature.
 *   -V##  attachment group (skip the 4-char counter itself)
 *   -A##  controller indexed signatures, ## of them, 88 chars each
 *   -B##  witness indexed signatures,    ## of them, 88 chars each
 */
export function countSignatures(atc: string): { controllerSignatures: number; witnessReceipts: number } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const b64ToInt = (t: string) => [...t].reduce((n, c) => n * 64 + alphabet.indexOf(c), 0);
  const counts: Record<string, number> = { "-A": 0, "-B": 0 };
  let i = atc.startsWith("-V") ? 4 : 0;
  while (i + 4 <= atc.length) {
    const code = atc.slice(i, i + 2);
    if (!(code in counts)) break; // anything else: stop counting rather than guess
    const n = b64ToInt(atc.slice(i + 2, i + 4));
    counts[code] += n;
    i += 4 + n * 88;
  }
  return { controllerSignatures: counts["-A"], witnessReceipts: counts["-B"] };
}
