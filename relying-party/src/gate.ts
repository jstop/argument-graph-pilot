// The gate, the log file, and the only way from one to the other.
//
// Every candidate entry goes through the same checks in the same order
// and stops at the first failure. A check that throws, fails. Every
// decision, accept or reject, is appended to decisions.jsonl with the
// check that failed. The log file is written from exactly one place,
// `Gate.submit`, after every check passed; `LogFile` is not exported.
// Our own genesis record takes the same path.
//
//   1 signature   the author's key event log, pulled fresh through OUR
//                 KERIA agent, holds at the stated sequence number an
//                 interaction event by the author that seals the payload
//                 digest. KERIA (keripy) verified its signatures against
//                 the key state the log establishes. We additionally
//                 count the witness receipts on the event and compare
//                 them with the author's declared threshold.
//   2 membership  the credential the payload cites was presented to us
//                 and verified by our KERIA on admit (digests, issuer
//                 signature chain, schema); it comes from the community
//                 issuer, uses the membership schema, and names the
//                 author as its subject; its registry's inception is
//                 sealed in the issuer's own key event log.
//   3 standing    the issuer's key event log, pulled fresh through the
//                 witnesses, seals the credential's issuance and does
//                 NOT seal a second registry event for it (the only
//                 second event a credential can have is its revocation).
//   4 target      support/attack names a record already in the log.
//
// What this gate does not do itself: verify any signature. It trusts its
// own KERIA for that, as demo2 did, and says so in each decision. The
// independent verifier (verifier/) is what does not.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countSignatures } from "@pilot/common";
import { chainProblem, makeRecord, saidOk, type Anchor, type EntryPayload, type GenesisPayload, type LogRecord } from "@pilot/common/src/log";

export type CheckName = "request" | "signature" | "membership" | "standing" | "target";
export interface CheckResult { check: CheckName; ok: boolean; detail: string; verifiedBy: "this service" | "our KERIA agent" | "this service, from events our KERIA agent verified" }
export interface Decision {
  dt: string; payload: string; kind: string; author: string;
  decision: "accept" | "reject"; failed: CheckName | "error" | null;
  checks: CheckResult[]; record: string | null;
  /** How far the issuer's key event log reached when we looked. */
  issuerSeen: string | null;
}

export interface KeyEvent { ked: any; atc: string }
/** What the gate needs from KERI. The one implementation asks our KERIA agent (core.ts). */
export interface KeriView {
  /** The AID's verified event at sequence number `sn` (hex), after refreshing its log through the witnesses. */
  eventAt(aid: string, sn: string): Promise<KeyEvent | undefined>;
  /** Declared witness threshold of the AID (current key state). */
  witnessThreshold(aid: string): Promise<number | undefined>;
  /** A credential our agent verified when it was presented to us; undefined if it never was. */
  verifiedCredential(said: string): Promise<{ sad: any } | undefined>;
  /** The community issuer's verified key event log, refreshed through the witnesses now. */
  issuerEvents(): Promise<KeyEvent[]>;
}

/** What the issuer's key event log says about credentials and about this log. Shared with the projection. */
export interface IssuerFacts {
  seenSn: number;
  sealed: Set<string>;                 // `${i}|${s}` for every {i,s,d} seal
  revokedAt: Map<string, number>;      // credential SAID -> issuer sn of the seal with s=1
  checkpoints: Array<{ sn: number; head: string }>;   // digest-only seals
}

export function issuerFacts(events: KeyEvent[]): IssuerFacts {
  const f: IssuerFacts = { seenSn: -1, sealed: new Set(), revokedAt: new Map(), checkpoints: [] };
  for (const { ked } of events) {
    const sn = parseInt(ked.s, 16);
    f.seenSn = Math.max(f.seenSn, sn);
    for (const seal of Array.isArray(ked.a) ? ked.a : []) {
      const keys = Object.keys(seal ?? {});
      if (keys.length === 1 && keys[0] === "d") f.checkpoints.push({ sn, head: seal.d });
      else if (typeof seal?.i === "string" && typeof seal?.s === "string") {
        f.sealed.add(`${seal.i}|${parseInt(seal.s, 16)}`);
        if (parseInt(seal.s, 16) === 1 && !f.revokedAt.has(seal.i)) f.revokedAt.set(seal.i, sn);
      }
    }
  }
  return f;
}

class LogFile {
  readonly records: LogRecord<any>[] = [];
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) this.records.push(JSON.parse(line));
      const problem = chainProblem(this.records);
      if (problem) throw new Error(`log file ${path} is damaged: ${problem}. Refusing to start on it.`);
    }
  }
  append(record: LogRecord<any>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", { mode: 0o644 });
    this.records.push(record);
  }
}

export interface GateConfig { dataDir: string; issuer: string; schema: string; maxTextLength: number }

export class Gate {
  private readonly file: LogFile;
  private readonly decisionsPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: GateConfig, private readonly keri: KeriView) {
    this.file = new LogFile(join(config.dataDir, "log.jsonl"));
    this.decisionsPath = join(config.dataDir, "decisions.jsonl");
  }

  get log(): readonly LogRecord<any>[] { return this.file.records; }
  get head(): LogRecord<any> | undefined { return this.file.records[this.file.records.length - 1]; }
  get genesis(): LogRecord<GenesisPayload> | undefined { return this.file.records[0]; }

  decisions(): Decision[] {
    if (!existsSync(this.decisionsPath)) return [];
    return readFileSync(this.decisionsPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  /** One at a time: the position and previous-record link are decided at append. */
  submit(payload: EntryPayload | GenesisPayload, anchorSn: string): Promise<Decision> {
    const run = this.queue.then(() => this.decide(payload, anchorSn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async decide(payload: any, anchorSn: string): Promise<Decision> {
    const checks: CheckResult[] = [];
    let failed: Decision["failed"] = null;
    let issuerSeen: string | null = null;
    let anchor: Anchor | undefined;
    const isGenesis = payload?.kind === "genesis";
    const signer: string = isGenesis ? payload?.operator : payload?.author;
    const need = (check: CheckName, ok: boolean, detail: string, verifiedBy: CheckResult["verifiedBy"]) => {
      checks.push({ check, ok, detail, verifiedBy });
      if (!ok) throw new Rejected(check);
    };
    try {
      // 0 request: shape only. Not one of the four, but nothing malformed goes further.
      const shape = isGenesis ? this.genesisShapeProblem(payload) : this.entryShapeProblem(payload);
      need("request", !shape, shape ?? "well-formed payload for this log", "this service");

      // 1 signature
      const ev = /^[0-9a-f]+$/.test(anchorSn) ? await this.keri.eventAt(signer, anchorSn) : undefined;
      const seals = ev && ev.ked.t === "ixn" && ev.ked.i === signer && Array.isArray(ev.ked.a)
        && ev.ked.a.some((s: any) => s && Object.keys(s).length === 1 && s.d === payload.d);
      need("signature", !!seals, !ev ? `no verified event ${anchorSn} in the key event log of ${signer}`
        : seals ? `event ${parseInt(anchorSn, 16)} of ${signer} seals ${payload.d}; its signatures were verified by our KERIA agent` : `event ${anchorSn} does not seal ${payload.d}`,
        "our KERIA agent");
      const counts = countSignatures(ev!.atc);
      const toad = await this.keri.witnessThreshold(signer);
      need("signature", toad !== undefined && counts.controllerSignatures >= 1 && counts.witnessReceipts >= toad,
        `${counts.controllerSignatures} controller signature(s), ${counts.witnessReceipts} witness receipt(s), declared threshold ${toad ?? "unknown"} (counted, not re-verified, by this service)`,
        "this service, from events our KERIA agent verified");
      anchor = { s: anchorSn, d: ev!.ked.d, ked: ev!.ked, atc: ev!.atc };

      if (!isGenesis) {
        // 2 membership
        const cred = await this.keri.verifiedCredential(payload.credential);
        need("membership", !!cred, cred ? `credential ${payload.credential} was presented to us and verified by our KERIA agent on admit` : `credential ${payload.credential} was never presented to us`, "our KERIA agent");
        const sad = cred!.sad;
        const policy = sad.i !== this.config.issuer ? `issued by ${sad.i}, not the community issuer`
          : sad.s !== this.config.schema ? `schema ${sad.s} is not the membership schema`
          : sad.a?.i !== payload.author ? `issued to ${sad.a?.i}, not to the author` : undefined;
        need("membership", !policy, policy ?? `from the community issuer, membership schema, issued to the author as '${sad.a.handle}'`, "this service");
        const facts = issuerFacts(await this.keri.issuerEvents());
        issuerSeen = facts.seenSn.toString(16);
        need("membership", facts.sealed.has(`${sad.ri}|0`), facts.sealed.has(`${sad.ri}|0`) ? `registry ${sad.ri} was created in the issuer's own key event log` : `registry ${sad.ri} is not sealed in the issuer's key event log`,
          "this service, from events our KERIA agent verified");

        // 3 standing
        need("standing", facts.sealed.has(`${payload.credential}|0`), facts.sealed.has(`${payload.credential}|0`) ? `issuance sealed in the issuer's key event log` : `the issuer's key event log does not seal an issuance of ${payload.credential}`,
          "this service, from events our KERIA agent verified");
        const rev = facts.revokedAt.get(payload.credential);
        need("standing", rev === undefined, rev === undefined ? `no revocation sealed in the issuer's key event log up to event ${facts.seenSn}` : `revoked: the issuer's event ${rev} seals a second registry event for this credential`,
          "this service, from events our KERIA agent verified");

        // 4 target
        if (payload.kind !== "claim") {
          const t = this.file.records.find((r) => r.d === payload.target);
          need("target", !!t && t.n > 0, t && t.n > 0 ? `targets record ${t.n}` : `target ${payload.target} is not in the log`, "this service");
        }
      } else {
        need("request", this.file.records.length === 0, this.file.records.length === 0 ? "the log is empty" : "the log already has a genesis record", "this service");
      }
    } catch (e) {
      failed = e instanceof Rejected ? e.check : "error";
      if (!(e instanceof Rejected)) checks.push({ check: checks[checks.length - 1]?.check ?? "request", ok: false, detail: `internal error, failing closed: ${e instanceof Error ? e.message : e}`, verifiedBy: "this service" });
    }

    let record: LogRecord<any> | null = null;
    if (failed === null && anchor) {
      record = makeRecord(this.head ?? null, payload, anchor);
    }
    const decision: Decision = { dt: new Date().toISOString(), payload: String(payload?.d), kind: String(payload?.kind), author: String(signer),
      decision: record ? "accept" : "reject", failed: record ? null : failed ?? "error", checks, record: record?.d ?? null, issuerSeen };
    // The decision is written first. If that fails, nothing is appended.
    mkdirSync(dirname(this.decisionsPath), { recursive: true });
    appendFileSync(this.decisionsPath, JSON.stringify(decision) + "\n");
    if (record) this.file.append(record);
    return decision;
  }

  private entryShapeProblem(p: any): string | undefined {
    if (!p || typeof p !== "object" || !saidOk(p)) return "payload does not hash to its identifier";
    if (!this.genesis) return "the log has no genesis record yet";
    if (p.log !== this.genesis.d) return "payload was made for a different log";
    if (!["claim", "support", "attack"].includes(p.kind)) return `unknown kind ${p.kind}`;
    if (typeof p.text !== "string" || p.text.trim() === "") return "text is required";
    if ([...p.text].length > this.config.maxTextLength) return `text is longer than ${this.config.maxTextLength} characters`;
    if ((p.kind === "claim") !== (p.target === undefined)) return "a claim has no target; support and attack need one";
    if (typeof p.author !== "string" || typeof p.credential !== "string") return "author and credential are required";
    return undefined;
  }

  private genesisShapeProblem(p: any): string | undefined {
    if (!p || !saidOk(p)) return "payload does not hash to its identifier";
    if (p.issuer !== this.config.issuer || p.schema !== this.config.schema) return "genesis does not name the configured issuer and schema";
    return undefined;
  }
}

class Rejected extends Error { constructor(readonly check: CheckName) { super(check); } }
