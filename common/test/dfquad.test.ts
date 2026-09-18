import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DfQuadError, Q, aggregate, evaluate, type Entry } from "../src/dfquad";

interface Expect {
  strength: string;
  display: string;
  counted: boolean;
}
interface Suite {
  params: Record<string, unknown>;
  vectors: { name: string; note: string; entries: Entry[]; expect: Record<string, Expect> }[];
  errors: { name: string; params?: unknown; entries: Entry[]; error: string }[];
}

const suite: Suite = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "semantics", "vectors.json"), "utf8"),
);
const PARAMS = suite.params;

for (const v of suite.vectors) {
  test(`vector: ${v.name}`, () => {
    const results = evaluate(v.entries, PARAMS);
    assert.deepEqual(
      results.map((r) => r.id),
      v.entries.map((e) => e.id),
    );
    assert.deepEqual(Object.keys(v.expect).sort(), results.map((r) => r.id).sort());
    for (const r of results) {
      const want = v.expect[r.id];
      assert.equal(r.strength, want.strength, `${r.id} strength`);
      assert.equal(r.display, want.display, `${r.id} display`);
      assert.equal(r.counted, want.counted, `${r.id} counted`);
    }
  });
}

for (const c of suite.errors) {
  test(`error vector: ${c.name}`, () => {
    assert.throws(
      () => evaluate(c.entries, c.params ?? PARAMS),
      (err: unknown) => err instanceof DfQuadError && err.code === c.error,
    );
  });
}

test("attackers and supporters list counted ids in log order", () => {
  const v = suite.vectors.find((x) => x.name === "mixed-graph")!;
  const byId = new Map(evaluate(v.entries, PARAMS).map((r) => [r.id, r]));
  assert.deepEqual(byId.get("e1")!.attackers, ["e3"]);
  assert.deepEqual(byId.get("e1")!.supporters, ["e4"]);
  assert.deepEqual(byId.get("e6")!.attackers, ["e8"]);
  assert.deepEqual(byId.get("e10")!.attackers, []);
});

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test("multiplying attackers in any order gives the same result", () => {
  // aggregate() directly: 1 - (1/2)(3/4)(5/8)(21/32)(15/16) = 28043/32768
  const values = [Q.of(1n, 2n), Q.of(1n, 4n), Q.of(3n, 8n), Q.of(11n, 32n), Q.of(1n, 16n)];
  for (const p of permutations(values)) assert.equal(aggregate(p).toString(), "28043/32768");
  assert.equal(aggregate([]).toString(), "0/1");

  // evaluate(): attackers of c with strengths 1/2, 1/4, 3/8, 3/4 in every log order.
  // F = 1 - (1/2)(3/4)(5/8)(1/4) = 241/256; c = 1/2 - 241/512 = 15/512 = 0.029296875
  const head: Entry[] = [{ id: "c", kind: "claim", author: "alice" }];
  const attackers: Entry[] = ["p", "q", "r", "s"].map((id, i) => ({
    id,
    kind: "attack",
    author: `u${i}`,
    target: "c",
  }));
  const tail: Entry[] = [
    { id: "q1", kind: "attack", author: "v", target: "q" },
    { id: "r1", kind: "attack", author: "v", target: "r" },
    { id: "r2", kind: "attack", author: "w", target: "r1" },
    { id: "s1", kind: "support", author: "v", target: "s" },
  ];
  for (const middle of permutations(attackers)) {
    const c = evaluate([...head, ...middle, ...tail], PARAMS)[0];
    assert.equal(c.strength, "15/512");
    assert.equal(c.display, "0.0293");
    assert.deepEqual(c.attackers, middle.map((e) => e.id));
  }
});

test("display is half-even from the exact value", () => {
  const cases: [bigint, bigint, string][] = [
    [1n, 32n, "0.0312"],
    [3n, 32n, "0.0938"],
    [11n, 32n, "0.3438"],
    [21n, 64n, "0.3281"],
    [3n, 64n, "0.0469"],
    [0n, 1n, "0.0000"],
    [1n, 1n, "1.0000"],
    [1n, 3n, "0.3333"],
    [2n, 3n, "0.6667"],
    [199999n, 200000n, "1.0000"],
  ];
  for (const [n, d, want] of cases) assert.equal(Q.of(n, d).toDisplay(), want);
  const eps = Q.of(1n, 2n ** 60n);
  assert.equal(Q.of(1n, 32n).add(eps).toDisplay(), "0.0313");
  assert.equal(Q.of(3n, 32n).sub(eps).toDisplay(), "0.0937");
});

test("integers serialize as n/1", () => {
  const log: Entry[] = [
    { id: "c", kind: "claim", author: "a" },
    { id: "x", kind: "attack", author: "b", target: "c" },
  ];
  const [c, x] = evaluate(log, { ...PARAMS, base_score: "1/1" });
  assert.deepEqual([c.strength, c.display], ["0/1", "0.0000"]);
  assert.deepEqual([x.strength, x.display], ["1/1", "1.0000"]);
});

test("another base score, by hand (tau = 1/3)", () => {
  // attacked: 1/3 - 1/3*1/3 = 2/9; supported: 1/3 + 2/3*1/3 = 5/9
  const got = evaluate(
    [
      { id: "c", kind: "claim", author: "a" },
      { id: "d", kind: "claim", author: "a" },
      { id: "x", kind: "attack", author: "b", target: "c" },
      { id: "y", kind: "support", author: "b", target: "d" },
    ],
    { ...PARAMS, base_score: "1/3" },
  );
  assert.deepEqual(
    got.map((r) => [r.strength, r.display]),
    [
      ["2/9", "0.2222"],
      ["5/9", "0.5556"],
      ["1/3", "0.3333"],
      ["1/3", "0.3333"],
    ],
  );
});

test("parameters are refused, not defaulted", () => {
  const display = PARAMS.display as Record<string, unknown>;
  const { duplicates: _dropped, ...withoutDuplicates } = PARAMS;
  const bad: unknown[] = [
    { ...PARAMS, semantics: "quad" },
    { ...PARAMS, influence: "euler" },
    { ...PARAMS, duplicates: "all" },
    { ...PARAMS, base_score: "2/4" },
    { ...PARAMS, base_score: "3/2" },
    { ...PARAMS, base_score: 0.5 },
    { ...PARAMS, base_score: "0.5" },
    { ...PARAMS, display: { ...display, decimals: 6 } },
    { ...PARAMS, display: { ...display, decimals: "4" } },
    withoutDuplicates,
    { ...PARAMS, cap: 64 },
    null,
  ];
  for (const p of bad) {
    assert.throws(
      () => evaluate([{ id: "c", kind: "claim", author: "a" }], p),
      (err: unknown) => err instanceof DfQuadError && err.code === "unsupported-parameter",
      JSON.stringify(p),
    );
  }
});

function bitLength(n: bigint): number {
  return n.toString(2).length;
}
function maxDenominatorBits(entries: Entry[]): number {
  return Math.max(...evaluate(entries, PARAMS).map((r) => bitLength(BigInt(r.strength.split("/")[1]))));
}

test("measured denominator growth (numbers quoted in SEMANTICS.md)", () => {
  const chain: Entry[] = [{ id: "e0", kind: "claim", author: "a" }];
  for (let i = 1; i < 200; i++) {
    chain.push({ id: `e${i}`, kind: "attack", author: i % 2 ? "b" : "a", target: `e${i - 1}` });
  }
  assert.equal(maxDenominatorBits(chain), 201);

  const tree: Entry[] = [{ id: "n", kind: "claim", author: "root" }];
  let level = ["n"];
  for (let depth = 0; depth < 8; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      for (let k = 0; k < 3; k++) {
        const id = `${parent}.${k}`;
        tree.push({ id, kind: "attack", author: `u${k}`, target: parent });
        next.push(id);
      }
    }
    level = next;
  }
  assert.equal(tree.length, 9841);
  assert.equal(maxDenominatorBits(tree), 9842);
});
