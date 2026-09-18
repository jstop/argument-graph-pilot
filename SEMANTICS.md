# Argument strength semantics (PROPOSED)

Status: **proposed**. Everything in this document is a proposal for the owner to
accept, change or reject. Nothing here is decided. Open items are collected in
section 9.

The gradual semantics used is DF-QuAD, as described in Rago, Toni, Aurisicchio,
Baroni, "Discontinuity-Free Decision Support with Quantitative Argumentation
Debates", KR 2016. This document specifies how a log is mapped onto it and how
values are computed and serialized so that two implementations agree to the
character.

Implementations held to this document:

- TypeScript: `common/src/dfquad.ts` (tests: `npx tsx --test common/test/dfquad.test.ts`)
- Python: `verifier/arglog_verifier/dfquad.py` (tests: `cd verifier && python -m pytest -q`)

Both load `semantics/vectors.json` and assert exact string equality.

## 1. Input

An ordered list of entries, in log order. Each entry has:

| field    | type   | rule |
|----------|--------|------|
| `id`     | string | unique in the log |
| `kind`   | `"claim"`, `"support"` or `"attack"` | |
| `author` | string | |
| `target` | string | id of an EARLIER entry. Required for `support` and `attack`; absent for `claim` |

and a genesis parameter object:

```json
{"semantics":"df-quad","base_score":"1/2","aggregation":"probabilistic-sum","influence":"df-quad-combination","arithmetic":"exact-rational","display":{"decimals":4,"rounding":"half-even"},"duplicates":"first-per-author-target-kind"}
```

An implementation must REFUSE (throw) any parameter value it does not
implement. It must not fall back to a default. Both implementations here accept
exactly the values above, with one exception: `base_score` may be any rational
in [0, 1] written in canonical form (section 5), because the formulas below are
written in terms of it. Missing keys and unknown extra keys are refused as well.

## 2. Arguments and edges

- EVERY entry is an argument with base score tau = `base_score`.
- A `support` or `attack` entry is an argument (its text is the reason given)
  with exactly one outgoing edge, of its kind, to its target. A `claim` has no
  outgoing edge.
- Because a target may be any earlier entry, an attack can itself be attacked or
  supported. No extra rule is needed for that.

### Duplicates (`first-per-author-target-kind`)

For each triple (author, target, kind), only the EARLIEST entry in log order
contributes an edge. A later entry with the same triple:

- is still an argument, with its own strength, and can itself be targeted;
- is reported with `counted: false`;
- contributes nothing to its target and does not appear in the target's
  `attackers` / `supporters`.

Claims are always `counted: true`. One author supporting AND attacking the same
target: the kinds differ, so both count.

An author supporting or attacking their own entry is counted like any other
edge. This is simply what the rule above does when nothing special is added;
whether it should be so is an open question for the owner (section 9).

## 3. Strength

Aggregation F over a multiset of strengths:

    F() = 0
    F(v1, ..., vn) = 1 - (1 - v1)(1 - v2)...(1 - vn)

With exact rationals multiplication is commutative and associative with no
rounding, so the product, and therefore every result, does not depend on the
order in which contributors are multiplied. Both test suites check this.

Combination, for an entry with base score tau:

    va = F(strengths of its counted attackers)
    vs = F(strengths of its counted supporters)

    va == vs :  sigma = tau
    va >  vs :  sigma = tau - tau * (va - vs)
    vs >  va :  sigma = tau + (1 - tau) * (vs - va)

With tau = 1/2 all three cases reduce to sigma = 1/2 + (vs - va)/2. The worked
examples use the three-case form so they can be redone for another tau.

## 4. Evaluation order and rejection

A target is always earlier in the log, so every edge points from a later entry
to an earlier one and the graph cannot contain a cycle. Evaluate in REVERSE log
order, last entry first: every attacker and supporter of an entry is later in
the log and has therefore already been evaluated. One pass. No iteration, no
convergence test, no tolerance.

The log is rejected (nothing is evaluated) on any of the following. The code is
what the `error` field of a negative vector names; both implementations expose
it as `.code` on the thrown error.

| code | condition |
|------|-----------|
| `unsupported-parameter` | any parameter value, missing key or extra key not implemented |
| `unknown-kind`          | `kind` is not one of the three |
| `duplicate-id`          | an `id` already used by an earlier entry |
| `claim-with-target`     | a claim carries a `target` |
| `edge-without-target`   | a support/attack has no `target` |
| `target-self`           | `target` equals the entry's own `id` |
| `target-not-earlier`    | `target` names an entry that is not earlier in the log (it appears later) |
| `target-missing`        | `target` names no entry in the log at all |
| `malformed-entry`       | `id`/`author`/`target` is not a string, or the entry is not an object |

Parameters are checked first; entries are then checked in log order and the
first failure is reported. Each negative vector contains exactly one fault, so
the vectors do not depend on this ordering.

## 5. Arithmetic and serialization

- All strengths are exact rationals in lowest terms.
- Normative serialization: the string `"n/d"`, decimal digits, no sign, no
  leading zeros, d > 0, gcd(n, d) = 1. Integers are written `n/1`: zero is
  `"0/1"`, one is `"1/1"`.
- Display value: a decimal string with exactly 4 places, rounded half-even,
  computed from the exact rational with integer arithmetic only, never via a
  float. With q = floor(n * 10^4 / d) and r = n * 10^4 - q * d: round up when
  2r > d, or when 2r = d and q is odd. The result is q written with a decimal
  point before its last four digits (`"0.0312"`, `"1.0000"`).
- The exact string is the normative value. The display string is derived from
  it and carries no authority of its own.

## 6. Output

One object per entry, in log order:

```json
{"id": "...", "strength": "n/d", "display": "0.1234", "counted": true,
 "attackers": ["ids of counted attackers, log order"],
 "supporters": ["ids of counted supporters, log order"]}
```

## 7. Worked vectors

All use the parameters of section 1 (tau = 1/2). Arrows read "targets". Each
value below was worked on paper from sections 2 to 5, in reverse log order. The
same values are in `semantics/vectors.json`.

**7.1 single-claim.** `c`.
No contributors: va = F() = 0, vs = F() = 0, equal, so c = tau = **1/2** -> `0.5000`.

**7.2 one-attack.** `c`; `a` attack -> c.
a: no contributors, a = 1/2.
c: va = F(1/2) = 1 - (1 - 1/2) = 1/2; vs = 0. va > vs:
c = 1/2 - 1/2 * (1/2 - 0) = 1/2 - 1/4 = **1/4** -> `0.2500`.

**7.3 one-support.** `c`; `s` support -> c.
s = 1/2. c: vs = 1/2, va = 0. vs > va:
c = 1/2 + (1 - 1/2) * (1/2 - 0) = 1/2 + 1/4 = **3/4** -> `0.7500`.

**7.4 attack-and-support-equal.** `c`; `a` attack -> c (bob); `s` support -> c (carol).
a = s = 1/2. c: va = 1/2, vs = 1/2, equal, so c = tau = **1/2** -> `0.5000`.

**7.5 two-attackers.** `c`; `a1` attack -> c (bob); `a2` attack -> c (carol).
a1 = a2 = 1/2. c: va = F(1/2, 1/2) = 1 - (1/2)(1/2) = 1 - 1/4 = 3/4; vs = 0.
c = 1/2 - 1/2 * 3/4 = 1/2 - 3/8 = 4/8 - 3/8 = **1/8** -> `0.1250`.

**7.6 attack-on-attack (reinstatement).** `c`; `a` attack -> c; `b` attack -> a.
b = 1/2.
a: va = 1/2, so a = 1/2 - 1/2 * 1/2 = **1/4** -> `0.2500`.
c: va = F(1/4) = 1/4, so c = 1/2 - 1/2 * 1/4 = 4/8 - 1/8 = **3/8** -> `0.3750`.
Compare 7.2: attacking the attacker moves c from 1/4 back up to 3/8, not all
the way to 1/2.

**7.7 support-of-attacker.** `c`; `a` attack -> c; `s` support -> a.
s = 1/2.
a: vs = 1/2, va = 0, so a = 1/2 + 1/2 * 1/2 = **3/4** -> `0.7500`.
c: va = 3/4, so c = 1/2 - 1/2 * 3/4 = 4/8 - 3/8 = **1/8** -> `0.1250`.

**7.8 duplicate-attack-same-author.** `c`; `a1` attack -> c (bob); `a2` attack -> c (bob); `x` attack -> a2 (carol).
(bob, c, attack) is first used by a1, so a2 is `counted: false`.
x = 1/2. a2: va = 1/2, a2 = **1/4**: it has its own strength although it is not counted.
a1 = 1/2. c: counted attackers are {a1} only: va = 1/2, c = **1/4**, identical to 7.2.

**7.9 same-author-attacks-and-supports.** `c`; `a` attack -> c (bob); `s` support -> c (bob).
Triples (bob, c, attack) and (bob, c, support) differ, both count. va = vs = 1/2, c = **1/2**.

**7.10 two-authors-attacking.** The log of 7.8 with a2 authored by dave.
Both count. x = 1/2, a2 = 1/4, a1 = 1/2.
c: va = F(1/2, 1/4) = 1 - (1/2)(3/4) = 1 - 3/8 = 5/8.
c = 1/2 - 1/2 * 5/8 = 8/16 - 5/16 = **3/16** = 0.1875 exactly -> `0.1875`.

**7.11 author-supports-own-claim.** `c` (alice); `s` support -> c (alice).
Counted like any other: c = **3/4** as in 7.3.

**7.12 rounding-tie-to-even-stays.** `c` with four attackers by four authors, each 1/2.
va = 1 - (1/2)^4 = 15/16. c = 1/2 - 1/2 * 15/16 = 16/32 - 15/32 = **1/32**.
1/32 = 0.03125 exactly. q = floor(10000/32) = 312, r = 10000 - 312*32 = 16,
2r = 32 = d: a tie. q = 312 is even, stay: `0.0312`.

**7.13 rounding-tie-to-even-moves.** Chain e1 <- e2 <- e3 <- e4 <- e5, all attacks.
e5 = 1/2; e4 = 1/2 - 1/2 * 1/2 = 1/4; e3 = 1/2 - 1/2 * 1/4 = 3/8;
e2 = 1/2 - 1/2 * 3/8 = 8/16 - 3/16 = 5/16 = 0.3125 -> `0.3125`;
e1 = 1/2 - 1/2 * 5/16 = 16/32 - 5/32 = **11/32** = 0.34375 exactly.
q = floor(110000/32) = 3437, r = 110000 - 3437*32 = 16, 2r = 32 = d: a tie.
q = 3437 is odd, round up: `0.3438`.

**7.14 rounding-non-tie-down.** The chain of 7.13 with a sixth entry e6 attacking e5.
Values shift one place: e6 = 1/2, e5 = 1/4, e4 = 3/8, e3 = 5/16, e2 = 11/32,
e1 = 1/2 - 1/2 * 11/32 = 32/64 - 11/64 = **21/64** = 0.328125.
q = floor(210000/64) = 3281, r = 210000 - 3281*64 = 16, 2r = 32 < 64: down, `0.3281`.

**7.15 rounding-non-tie-up.** `c`; `a1`..`a5` attack -> c (five authors); `s` support -> c; `x1`..`x3` attack -> s (three authors).
x1 = x2 = x3 = 1/2. s: va = 1 - (1/2)^3 = 7/8, s = 1/2 - 7/16 = **1/16** -> `0.0625`.
c: va = 1 - (1/2)^5 = 31/32; vs = F(1/16) = 1/16 = 2/32; va - vs = 29/32.
c = 1/2 - 1/2 * 29/32 = 32/64 - 29/64 = **3/64** = 0.046875.
q = floor(30000/64) = 468, r = 30000 - 468*64 = 48, 2r = 96 > 64: up, `0.0469`.

**7.16 mixed-graph.** Ten entries:

    e1 claim (alice)            e6  attack -> e1 (bob)     duplicate of e3's triple
    e2 claim (bob)              e7  support -> e4 (dave)
    e3 attack -> e1 (bob)       e8  attack -> e6 (carol)
    e4 support -> e1 (carol)    e9  support -> e2 (alice)
    e5 attack -> e3 (alice)     e10 attack -> e5 (dave)

Reverse order:
e10 = 1/2. e9 = 1/2. e8 = 1/2. e7 = 1/2.
e6: attacked by e8: 1/2 - 1/4 = **1/4**; `counted: false` because (bob, e1, attack) was used by e3.
e5: attacked by e10: **1/4**.
e4: supported by e7: 1/2 + 1/4 = **3/4**.
e3: attacked by e5 (1/4): 1/2 - 1/2 * 1/4 = **3/8**.
e2: supported by e9: **3/4**.
e1: counted attackers {e3}: va = 3/8. Counted supporters {e4}: vs = 3/4 = 6/8.
vs > va: e1 = 1/2 + 1/2 * (6/8 - 3/8) = 8/16 + 3/16 = **11/16** = 0.6875 -> `0.6875`.
Had e6 counted, va would be F(3/8, 1/4) = 1 - (5/8)(3/4) = 17/32 and e1 would
be 1/2 + 1/2 * (24/32 - 17/32) = 39/64, so the vector distinguishes the two.

### How the expected values were derived

The expected values in `semantics/vectors.json` were written by hand from the
arithmetic above, before either implementation was run against them. They were
then checked by a third, throwaway computation that shares no code with either
implementation and is built differently from both: a forward memoised recursion
(strength of an entry = recurse into whatever targets it) rather than a reverse
pass, using Python's `decimal` module at 5000 digits with the `Inexact` trap
armed for all strength arithmetic (every value here is a dyadic rational, which
is exact in decimal; any rounding would raise), `Decimal.as_integer_ratio` for
the `n/d` string and `Decimal.quantize(..., ROUND_HALF_EVEN)` for the display
string. It reported 16 vectors, 0 mismatches against the hand-written file. The
script was not kept in the repo.

The two implementations are also structurally unlike each other. The Python one
collects each entry's counted contributors into lists and applies F to them
(pull), on `fractions.Fraction`. The TypeScript one keeps a running product per
entry and has each evaluated entry multiply its factor into its target (push),
on its own `BigInt` rational, and rounds by a different integer formula
(floor of x * 10^4 + 1/2, then pulled back on an odd tie).

## 8. Cost

Exactness is not free. With base score 1/2 every denominator is a power of two,
and the exponent grows with the number and depth of contributors: F multiplies
the denominators of all contributors together, and the combination step adds
one more factor of two.

Measured with both implementations (the numbers are asserted in both test
suites), bit length of the largest denominator in the result:

| log | entries | largest denominator | bit length |
|-----|---------|---------------------|------------|
| (a) chain of single attacks, 200 entries | 200 | 2^200 | **201** |
| (b) full tree of attacks, width 3, depth 8 (root plus 8 levels) | 9841 | 2^9841 | **9842** |

In (b) the root's exact string is 5926 characters long. Evaluation time was not
a problem at this size (about 0.04 s in Python and 0.06 s in TypeScript on the
development machine), but the size of the serialized value is. For a full tree
of width w, the exponent obeys b(k+1) = w * b(k) + 1, so it grows with the
number of entries under the node, not with the depth alone.

No cap, truncation or fallback is specified. That is an open item.

## 9. Open items for the owner

1. The whole document is proposed; none of it is decided.
2. Self-support and self-attack (author targets their own entry) currently
   count like any other edge. Stated as an open question, not a position.
3. Denominator growth (section 8) has no cap. Any cap would change normative
   values and would need to be a genesis parameter.
4. `base_score` other than `"1/2"`: both implementations accept any canonical
   rational in [0, 1]; the shared vectors only exercise 1/2 (each test suite has
   one hand-worked tau = 1/3 case). The owner may prefer to refuse everything
   but 1/2.
5. Unknown extra keys and missing keys in the parameter object are refused.
6. The error codes of section 4, and the optional `params` field on a negative
   vector (needed to express the unknown-parameter case), are naming choices
   made here.
7. A `target` of JSON `null` is treated the same as an absent `target`.
8. An uncounted duplicate that is itself attacked or supported has a strength
   that affects nothing upstream. It is reported anyway.
