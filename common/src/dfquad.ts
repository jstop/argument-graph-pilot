// DF-QuAD strengths over an append-only argument log (proposed; see SEMANTICS.md).
// Exact rationals on BigInt. No Number arithmetic touches a strength.

export type Kind = "claim" | "support" | "attack";

export interface Entry {
  id: string;
  kind: Kind;
  author: string;
  target?: string;
}

export interface Result {
  id: string;
  strength: string; // "n/d", lowest terms: the normative value
  display: string; // 4 decimals, half-even: derived
  counted: boolean;
  attackers: string[];
  supporters: string[];
}

export type ErrorCode =
  | "unsupported-parameter"
  | "malformed-entry"
  | "unknown-kind"
  | "duplicate-id"
  | "claim-with-target"
  | "edge-without-target"
  | "target-self"
  | "target-not-earlier"
  | "target-missing";

export class DfQuadError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DfQuadError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- rationals

/** Rational, always in lowest terms with d > 0. */
export class Q {
  private constructor(readonly n: bigint, readonly d: bigint) {}

  static readonly ZERO = new Q(0n, 1n);
  static readonly ONE = new Q(1n, 1n);

  static of(n: bigint, d: bigint): Q {
    if (d === 0n) throw new RangeError("zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    let a = n < 0n ? -n : n;
    let b = d;
    while (b !== 0n) [a, b] = [b, a % b];
    return new Q(n / a, d / a);
  }

  /** Accepts only the canonical serialization. */
  static parse(text: string): Q | null {
    const m = /^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text);
    if (!m) return null;
    const q = Q.of(BigInt(m[1]), BigInt(m[2]));
    return q.toString() === text ? q : null;
  }

  add(o: Q): Q {
    return Q.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return Q.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return Q.of(this.n * o.n, this.d * o.d);
  }
  cmp(o: Q): -1 | 0 | 1 {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  toString(): string {
    return `${this.n}/${this.d}`;
  }

  /** Four decimals, round-half-even, from the exact value. */
  toDisplay(): string {
    if (this.n < 0n) throw new RangeError("negative strength");
    // floor(x * 10^4 + 1/2) is half-up; a tie that landed on an odd digit is pulled back.
    const num = 2n * this.n * 10000n + this.d;
    const den = 2n * this.d;
    let scaled = num / den;
    if (num % den === 0n && scaled % 2n === 1n) scaled -= 1n;
    const digits = scaled.toString().padStart(5, "0");
    return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
  }
}

/** F() = 0; F(v1..vn) = 1 - prod(1 - vi). */
export function aggregate(values: readonly Q[]): Q {
  return Q.ONE.sub(values.reduce((rest, v) => rest.mul(Q.ONE.sub(v)), Q.ONE));
}

// --------------------------------------------------------------- parameters

const ONLY: Record<string, string> = {
  semantics: "df-quad",
  aggregation: "probabilistic-sum",
  influence: "df-quad-combination",
  arithmetic: "exact-rational",
  duplicates: "first-per-author-target-kind",
};
const PARAM_KEYS = [...Object.keys(ONLY), "base_score", "display"].sort();

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Refuses anything this implementation does not implement; returns the base score. */
export function checkParams(params: unknown): Q {
  const no = (detail: string): never => {
    throw new DfQuadError("unsupported-parameter", detail);
  };
  if (!isObject(params)) return no("params must be an object");
  if (JSON.stringify(Object.keys(params).sort()) !== JSON.stringify(PARAM_KEYS)) {
    return no(`expected exactly the keys ${PARAM_KEYS.join(", ")}`);
  }
  for (const [key, value] of Object.entries(ONLY)) {
    if (params[key] !== value) no(`${key}=${JSON.stringify(params[key])}`);
  }
  const display = params.display;
  if (!isObject(display) || JSON.stringify(Object.keys(display).sort()) !== '["decimals","rounding"]') {
    return no("display");
  }
  if (display.decimals !== 4) no(`display.decimals=${JSON.stringify(display.decimals)}`);
  if (display.rounding !== "half-even") no(`display.rounding=${JSON.stringify(display.rounding)}`);
  const tau = typeof params.base_score === "string" ? Q.parse(params.base_score) : null;
  if (tau === null || tau.cmp(Q.ONE) > 0) {
    return no(`base_score=${JSON.stringify(params.base_score)} (canonical n/d within [0, 1])`);
  }
  return tau;
}

// --------------------------------------------------------------- evaluation

interface Node {
  entry: Entry;
  counted: boolean;
  // Running prod(1 - v) over counted contributors seen so far, and their ids.
  attackRest: Q;
  supportRest: Q;
  attackers: string[];
  supporters: string[];
  strength?: Q;
}

function buildNodes(entries: readonly unknown[]): Node[] {
  const allIds = new Set<unknown>(entries.map((e) => (isObject(e) ? e.id : undefined)));
  const earlier = new Set<string>();
  const firstEdge = new Set<string>();
  const nodes: Node[] = [];

  entries.forEach((raw, i) => {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.author !== "string") {
      throw new DfQuadError("malformed-entry", `entry ${i}`);
    }
    const { id, kind, author } = raw;
    const target = raw.target ?? undefined;
    if (kind !== "claim" && kind !== "support" && kind !== "attack") {
      throw new DfQuadError("unknown-kind", `${id}: ${JSON.stringify(kind)}`);
    }
    if (earlier.has(id)) throw new DfQuadError("duplicate-id", id);

    let counted = true;
    if (kind === "claim") {
      if (target !== undefined) throw new DfQuadError("claim-with-target", id);
    } else {
      if (target === undefined) throw new DfQuadError("edge-without-target", id);
      if (typeof target !== "string") throw new DfQuadError("malformed-entry", `${id}: target`);
      if (target === id) throw new DfQuadError("target-self", id);
      if (!earlier.has(target)) {
        throw new DfQuadError(allIds.has(target) ? "target-not-earlier" : "target-missing", `${id} -> ${target}`);
      }
      // JSON.stringify of the triple is an unambiguous key whatever the strings contain.
      const edgeKey = JSON.stringify([author, target, kind]);
      counted = !firstEdge.has(edgeKey);
      firstEdge.add(edgeKey);
    }
    earlier.add(id);
    nodes.push({
      entry: { id, kind, author, ...(target === undefined ? {} : { target }) },
      counted,
      attackRest: Q.ONE,
      supportRest: Q.ONE,
      attackers: [],
      supporters: [],
    });
  });
  return nodes;
}

export function evaluate(entries: readonly Entry[], params: unknown): Result[] {
  const tau = checkParams(params);
  const nodes = buildNodes(entries);
  const byId = new Map(nodes.map((n) => [n.entry.id, n] as const));

  // Last entry first: whoever points at a node sits after it in the log, so by the time
  // a node is reached every counted contributor has already pushed its factor into it.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const va = Q.ONE.sub(node.attackRest);
    const vs = Q.ONE.sub(node.supportRest);
    const order = va.cmp(vs);
    const strength =
      order === 0
        ? tau
        : order > 0
          ? tau.sub(tau.mul(va.sub(vs)))
          : tau.add(Q.ONE.sub(tau).mul(vs.sub(va)));
    node.strength = strength;

    if (node.counted && node.entry.target !== undefined) {
      const target = byId.get(node.entry.target)!;
      const factor = Q.ONE.sub(strength);
      if (node.entry.kind === "attack") {
        target.attackRest = target.attackRest.mul(factor);
        target.attackers.unshift(node.entry.id); // visited in reverse; keep log order
      } else {
        target.supportRest = target.supportRest.mul(factor);
        target.supporters.unshift(node.entry.id);
      }
    }
  }

  return nodes.map((n) => ({
    id: n.entry.id,
    strength: n.strength!.toString(),
    display: n.strength!.toDisplay(),
    counted: n.counted,
    attackers: n.attackers,
    supporters: n.supporters,
  }));
}
