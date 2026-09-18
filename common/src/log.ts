// The log's record format. One append-only, hash-chained sequence; every
// record is self-addressing (its `d` is the digest of the rest of it).
//
// Two layers, because the wallet signs by sealing ONE digest in the
// author's key event log and an entry cannot contain its own signature:
//
//   payload  what the phone shows and the author approves. Its digest is
//            what the author's interaction event seals. Field order is
//            display order on the phone; `d` is hidden there.
//   record   the payload, plus the sealing event with its signatures and
//            witness receipts, plus the link to the previous record.
//
// The previous-record link is the operator's, not the author's: the
// author does not know the log head when approving. See DESIGN.md.
import signify from "signify-ts";

export const RECORD_VERSION = "arglog/1";
export const EXPORT_FORMAT = "arglog-export/1";
export type Kind = "claim" | "support" | "attack";

export interface SemanticsParams {
  semantics: "df-quad";
  base_score: string;
  aggregation: "probabilistic-sum";
  influence: "df-quad-combination";
  arithmetic: "exact-rational";
  display: { decimals: number; rounding: "half-even" };
  duplicates: "first-per-author-target-kind";
}

/** The parameters this pilot declares. They live in the genesis record, not here: this is only what a NEW log is created with. */
export const PILOT_SEMANTICS: SemanticsParams = {
  semantics: "df-quad",
  base_score: "1/2",
  aggregation: "probabilistic-sum",
  influence: "df-quad-combination",
  arithmetic: "exact-rational",
  display: { decimals: 4, rounding: "half-even" },
  duplicates: "first-per-author-target-kind",
};

export interface GenesisPayload {
  d: string; kind: "genesis"; community: string;
  /** The ONLY issuer whose membership credentials count, and the schema they must use. */
  issuer: string; schema: string;
  /** The AID that operates this log and seals this payload in its own key event log. */
  operator: string;
  semantics: SemanticsParams; dt: string;
}

export interface EntryPayload {
  d: string; kind: Kind; text: string; target?: string;
  author: string; credential: string;
  /** SAID of the genesis record: a payload approved for one log cannot be replayed into another. */
  log: string;
  /** The time the request was made, as claimed by the operator. Proves nothing. */
  dt: string;
}

/** The author's (or, for genesis, the operator's) interaction event sealing payload.d. */
export interface Anchor { s: string; d: string; ked: Record<string, unknown>; atc: string }

export interface LogRecord<P = EntryPayload | GenesisPayload> {
  format: typeof RECORD_VERSION; d: string; n: number; p: string | null; payload: P; anchor: Anchor;
}

const saidify = <T extends { d: string }>(sad: T): T => signify.Saider.saidify(sad)[1] as T;

export function saidOk(sad: { d?: unknown }): boolean {
  if (typeof sad?.d !== "string") return false;
  try { return signify.Saider.saidify({ ...sad, d: "" })[0].qb64 === sad.d; } catch { return false; }
}

export function genesisPayload(f: Omit<GenesisPayload, "d" | "kind" | "dt" | "semantics"> & { semantics?: SemanticsParams }): GenesisPayload {
  return saidify({ d: "", kind: "genesis" as const, community: f.community, issuer: f.issuer, schema: f.schema,
    operator: f.operator, semantics: f.semantics ?? PILOT_SEMANTICS, dt: new Date().toISOString() });
}

export function entryPayload(f: { kind: Kind; text: string; target?: string; author: string; credential: string; log: string }): EntryPayload {
  // Key order is what the phone displays, top to bottom.
  const p: Record<string, string> = { d: "", kind: f.kind, text: f.text };
  if (f.kind !== "claim") p.target = f.target!;
  Object.assign(p, { author: f.author, credential: f.credential, log: f.log, dt: new Date().toISOString() });
  return saidify(p as unknown as EntryPayload);
}

export function makeRecord<P extends { d: string }>(prev: LogRecord<any> | null, payload: P, anchor: Anchor): LogRecord<P> {
  return saidify({ format: RECORD_VERSION, d: "", n: prev ? prev.n + 1 : 0, p: prev ? prev.d : null, payload, anchor });
}

/** Re-checks digests, positions and links of a whole log. Returns the first problem, or undefined. */
export function chainProblem(log: LogRecord<any>[]): string | undefined {
  for (let i = 0; i < log.length; i++) {
    const r = log[i];
    if (r.format !== RECORD_VERSION) return `record ${i}: unknown version`;
    if (!saidOk(r)) return `record ${i}: does not hash to its identifier`;
    if (!saidOk(r.payload)) return `record ${i}: payload does not hash to its identifier`;
    if (r.n !== i) return `record ${i}: position says ${r.n}`;
    if (r.p !== (i === 0 ? null : log[i - 1].d)) return `record ${i}: does not link to the previous record`;
  }
  return undefined;
}
