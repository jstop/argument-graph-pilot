// Everything the pages show is computed here from two inputs: the log
// and what the issuer's key event log says (revocations, checkpoints).
// Nothing is stored. Delete every file but log.jsonl and the site
// renders the same.
//
// The standing rule is the one the independent verifier applies
// (DESIGN.md, "What establishes afterward"): an entry citing a revoked
// credential counts only if it lies within the last log head the issuer
// sealed in its own key event log BEFORE sealing the revocation.
import { evaluate, type Result } from "@pilot/common/src/dfquad";
import type { EntryPayload, GenesisPayload, LogRecord } from "@pilot/common/src/log";
import type { IssuerFacts } from "./gate";

export interface Node {
  record: LogRecord<EntryPayload>;
  handle: string;
  /** undefined: not an argument (see `excluded`). */
  result?: Result;
  excluded?: string;
  attackers: Node[]; supporters: Node[];
  /** Entries aimed at this one that do not count, with the reason. */
  inert: Array<{ node: Node; why: string }>;
}

export interface View { genesis?: LogRecord<GenesisPayload>; nodes: Node[]; byId: Map<string, Node>; issuerSeen: number }

export function project(log: readonly LogRecord<any>[], facts: IssuerFacts, handleOf: (credential: string) => string): View {
  const genesis = log[0] as LogRecord<GenesisPayload> | undefined;
  const byId = new Map<string, Node>();
  const nodes: Node[] = [];
  if (!genesis) return { nodes, byId, issuerSeen: facts.seenSn };

  const indexOf = new Map(log.map((r) => [r.d, r.n]));
  const covered = (credential: string): number => {
    const rev = facts.revokedAt.get(credential);
    if (rev === undefined) return Infinity;
    let h = -1;
    for (const c of facts.checkpoints) if (c.sn < rev && indexOf.has(c.head)) h = Math.max(h, indexOf.get(c.head)!);
    return h;
  };

  const graph: Array<{ id: string; kind: any; author: string; target?: string }> = [];
  for (const record of log.slice(1) as LogRecord<EntryPayload>[]) {
    const p = record.payload;
    const node: Node = { record, handle: handleOf(p.credential), attackers: [], supporters: [], inert: [] };
    byId.set(record.d, node);
    nodes.push(node);
    if (record.n > covered(p.credential)) node.excluded = "its author's membership was revoked before this entry, or not provably after it";
    else if (p.target !== undefined && byId.get(p.target)?.excluded) node.excluded = "its target is not an argument";
    else if (p.target !== undefined && !byId.has(p.target)) node.excluded = "its target is not in the log";
    else graph.push({ id: record.d, kind: p.kind, author: p.author, ...(p.target !== undefined ? { target: p.target } : {}) });
  }

  for (const r of evaluate(graph, genesis.payload.semantics)) byId.get(r.id)!.result = r;
  for (const node of nodes) {
    const t = node.record.payload.target !== undefined ? byId.get(node.record.payload.target) : undefined;
    if (!t) continue;
    if (node.excluded) t.inert.push({ node, why: node.excluded });
    else if (!node.result!.counted) t.inert.push({ node, why: "the same member already made this move on this entry; only the first counts" });
    else (node.record.payload.kind === "attack" ? t.attackers : t.supporters).push(node);
  }
  return { genesis, nodes, byId, issuerSeen: facts.seenSn };
}
