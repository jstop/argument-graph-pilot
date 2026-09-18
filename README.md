# Signed argument graph pilot: Veridian wallets + self-hosted KERI backend

Members of a small community, each holding a stock
[Veridian wallet](https://github.com/cardano-foundation/veridian-wallet)
with a **community membership credential** (an ACDC), work on one shared
argument: post a claim, support or attack someone else's, and watch every
claim's strength change. Every entry is sealed in its author's own key
event log by their phone. Anyone can download the log and reproduce, with
a separate program and without trusting the server, who said what and the
same numbers.

Everything runs on one box from docker compose: six KERI witnesses and
KERIA from Veridian's own self-deployment files (pinned by digest), plus
two small TypeScript services, plus a Python verifier that shares no code
with them. No ledger, no accounts, no LLM. Apache-2.0.

This README is for someone who knows KERI but not argumentation.
RUNBOOK.md stands it up and records the key-loss drills. TESTER.md is for
two people with phones. WALKTHROUGH.md teaches both halves from nothing.
SEMANTICS.md is the strength computation with worked vectors. DESIGN.md
lists every decision (all *proposed*), every Veridian-imposed constraint,
and every gap. It builds on `demo2` (credential pilot); its findings
still apply.

## Status, plainly

- **Works, tested against real KERIA and real witnesses with Signify
  clients as the phones:** the success criterion (A claims, B attacks,
  A's number goes 0.5000 → 0.2500), a really-signed rejection for every
  gate check, revocation, key rotation, and the independent verifier
  reproducing every author and number from the export alone, including
  against the deployed containers.
- Cloud mode is deployed (RUNBOOK §1a) and passes the same check over
  the internet with stand-in phones. **Not done: no real phone has run
  this.** TESTER.md is unexecuted. Non-ASCII text is
  tested end to end with stand-ins, not from a phone. The wallet shows
  only the first line of a long text on its signing screen (read from
  its source; DESIGN.md).
- **Stage 2 (a member's software agent) was stopped**, as the brief
  instructs: the stock wallet cannot approve a delegation (DESIGN.md).

## The argumentation half, in five lines

Each entry is an *argument* with a number in [0, 1], its *strength*.
Every argument starts at the same *base score*, 1/2. Supporters pull a
target's strength toward 1, attackers toward 0, each in proportion to its
own current strength; several attackers combine as 1 − ∏(1 − vᵢ). This is
DF-QuAD (Rago et al., KR 2016), evaluated in one pass because an entry
can only target an earlier one. The base score, functions and arithmetic
(exact fractions) are **declared in the log's first record**, and both
implementations refuse parameters they do not implement. One attack on a
fresh claim: 1/2 − 1/2 × 1/2 = 1/4.

## What runs

```
operator ──handle──▶ issuer ──IPEX grant──▶ phone             (membership credential)
phone ──scan──▶ relying party ──apply/offer/agree/grant──▶ verified once per member
browser: text ──▶ relying party ──remote-sign request──▶ phone: "Sign"
                 ◀── ixn in the author's KEL sealing the payload digest
                 gate: signature → membership → standing → target   (every decision recorded)
                 log.jsonl (hash-chained, SAIDed records) ──▶ pages, /export.json
issuer: revoke = seal the log head in the issuer's KEL, then revoke
verifier (Python/keripy): export.json ──▶ report
```

- **issuer/** demo2's issuer, re-pointed: handle in, membership
  credential out; `revoke` checkpoints the log first; serves each
  credential's CESR export (issuer KEL, registry, iss/rev events) at
  `/registry/<SAID>.cesr`, which is how the export gets registry events.
- **relying-party/** `gate.ts` (fixed-order, fail-closed, the only writer
  of the log), `projection.ts` (pages computed from the log and the
  issuer's KEL; nothing stored), `core.ts` (wallet flows: one
  presentation per member ever, then one **Sign** per entry),
  server-rendered pages: `/`, `/entry/<SAID>`, `/kel/<AID>`,
  `/decisions`, `/verify`, `/export.json`, `/log.json`.
- **verifier/** `python -m arglog_verifier export.json --issuer <AID>`.
  Replays every KEL with keripy as a third party (witness thresholds
  enforced), checks registry ownership and issuance anchoring, orders
  revocation against issuer checkpoints, recomputes every strength with
  its own DF-QuAD. Exit status 0 only if everything passed.
- **personal/** `python -m focus`: a personal attention list. Reads your
  own Episteme library read-only and the community log through the
  verifier, and says what deserves your attention, why, and what you
  could do, including "answer this publicly" links into the signing
  flow. Runs on your machine only. Optional; a scope change against the
  brief (DESIGN.md D10). `personal/README.md`.
- **common/** Signify helpers, the KERIA non-ASCII workaround, the log
  record format, the TypeScript DF-QuAD, the wallet stand-in.
- **schema/** `EKKBYCMIW65PqoodeRGOWqCo33SpXihGDLs1hy6SDSXe`: `i`, `dt`,
  `handle`. No scores, roles or reputation.
- **semantics/vectors.json** the vectors both DF-QuAD implementations
  must match exactly.
- **spike/** the experiments behind DESIGN.md (10–15 are this pilot's).

## Run it (local mode)

Docker with compose v2, Node 20, jq, curl; Python 3.12 + libsodium for
the verifier.

```
git clone --recurse-submodules <this repo> && cd <it>
npm install                                   # signify-ts is vendored at the wallet's commit
./infra/stack.sh up                           # witnesses, then KERIA
cp infra/services.env.example infra/services.env    # set OPERATOR_TOKEN (16+ chars, no default)
./infra/services.sh up                        # issuer :3110, the argument :3120
(cd verifier && python3.12 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt)

npm test                                      # 33 DF-QuAD + 15 issuer + 12 end-to-end, against the live stack
VERIFIER_PYTHON=$PWD/verifier/.venv/bin/python npm test -w relying-party   # so the end-to-end test also runs the verifier
(cd verifier && python -m pytest -q)          # 57: vectors + a recorded real log, tampered, truncated, under-receipted
OPERATOR_TOKEN=… npx tsx spike/12-drive-services.ts   # the success criterion against the containers
```

Phones need cloud mode: RUNBOOK.md.

## CI and deploys

Every push: secret scan (files and history), types, both DF-QuAD
implementations, the verifier on the recorded log. Main and nightly: the
real Veridian stack in the runner with the issuer and end-to-end suites.
Deploys are started by the owner, refuse unless both passed for that
commit, and only move a `production` tag: GitHub holds no credential for
the box, which pulls with its own read-only key and rolls back if the
issuer's identifier changes or the log shrinks. RUNBOOK §1b.

## Tests

No test uses a fake signer or a mocked KEL. Negative gate tests are
really signed by real identifiers and rejected anyway; negative verifier
tests are a recorded real log with bytes changed or removed.

- `relying-party/test/end-to-end.test.ts` — success criterion with a
  non-ASCII claim; second entry needs only a signature; returning member
  does not present again; duplicate attack does not count; rejections at
  `signature`, `membership` (twice), `target`, `request`, `standing`;
  "Don't allow"; someone else's credential; revocation keeps the earlier
  entry counting; every rejection on record; log replays and a damaged
  file is refused; the Python verifier agrees on every number and one
  changed byte fails `record`. If keripy is not importable that last
  test reports itself **skipped** and says so.
- `verifier/tests` — see its docstring for the two adversarial cases it
  does not cover and why.
- `issuer/test` — inception, issue, non-ASCII handle, rotation, session
  rules, auth, checkpoint-then-revoke at issuer events N and N+1.

## What is real and what is stubbed

Real: Veridian's KERIA fork and witnesses, unmodified; IPEX; remote
signing; witness receipts and thresholds; pre-rotation; revocation; the
independent verification. Stubbed or simplified (DESIGN.md has the full
list): one shared witness pool and KERIA; issuer and log run by the same
operator; a JSONL file as the log store; basic-auth operator page and
URL-bearer posting sessions; checkpoints only on revocation; the
verifier reads an export file rather than fetching from witnesses; no
cap on graph size.
