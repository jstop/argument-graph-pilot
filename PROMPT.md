# Signed argument graph pilot — scope and constraints

## Goal
A self-hosted pilot in which members of a small epistemic community,
each holding a Veridian wallet with a community membership credential,
work on one shared argument graph: post a claim, support or attack
someone else's claim, and watch every claim's strength change as a
result. Every entry is signed by its author's AID. Anyone can download
the log and reproduce, without trusting our server, who said what and
the same strengths. Everything is Apache-2 and clonable.

Success criterion: two testers, on their own phones, with written
instructions and no help from us: A posts a claim, B attacks it, both
see A's claim weaken. A third person who runs none of our services
downloads the log, runs the verifier, and gets the same authors and
the same numbers.

Two audiences:
- DIF / KERI community members who will clone the repo and run it.
- People who work on argumentation and epistemology, know neither
  KERI nor PKI, and will watch it run in a meeting.

## Starting point
`./demo2` is the base, not a reference. It already has the pinned
Veridian backend, our own witnesses, an issuer that grants an ACDC to
a phone wallet over IPEX, and a relying party that verifies a
presentation and accepts a signed text claim. Before designing
anything, read its DESIGN.md, RUNBOOK.md, TESTER.md, the findings from
the first real phone run, and every file in `spike/`. Copy what works
into this repo; do not re-derive it, and do not regress on anything
those documents record as a finding. Keep its stack: TypeScript
services, the vendored signify-ts build the wallet itself pins,
digest-pinned images, `wallet-standin.ts` as the phone stand-in.

Three facts about demo2 that shape this pilot:
- A holder's "signature" on a claim is not a detached signature. The
  wallet anchors the SAID of the claim payload in an interaction
  event in the holder's own KEL (Veridian's remote-sign flow), and
  the stored proof is that event plus its attachments. Nothing in
  demo2 signs an arbitrary payload with an AID key through Signify.
  Use the same mechanism here; do not invent another.
- demo2's relying party verifies nothing cryptographically in its own
  code. It trusts its KERIA, which is the same process the holders
  use. Three of its chain steps are hard-coded true, and witness
  receipts are counted for display but never compared to the
  holder's threshold. That was acceptable for demo2. Here it is the
  gap the independent verifier exists to close.
- `../demo/osmio_demo/verification.py` is a real keripy verifier with
  44 passing tests, and `../demo/DESIGN.md` records what keripy gets
  wrong for a verifier: `Parser.parse()` never returns on a
  truncated stream, keripy's `Verifier` keeps revoked credentials,
  and it does not check that a credential's registry belongs to its
  issuer (a forged credential naming the trusted issuer verifies).
  Start the verifier from that code and keep those fixes. Its tests
  run without witnesses; here receipt thresholds must be exercised.

Two older codebases hold ideas, not code to merge:
- `../Locus/locus-client-zero.zip` — a verifier gate as fixed-order,
  fail-closed checks that emits a receipt for every decision, and
  three scripts proving delegation, credential revocation, and
  recovery against keripy in-process. Take the check-ordering and
  fail-closed discipline. Leave bonds, standing queries, and
  adjudication behind.
- `../epistemic/workbench` — an argument workbench. Its own
  CURRENT_MODEL.md states that it contains no DF-QuAD (it is boolean
  ATMS plus LLM-driven tooling). An archived snapshot under
  `../epistemic/platform/docs/history/workbench-snapshot-2026-05-container/`
  has a DF-QuAD engine (`src/epistemic/engine.py`, `compute_dfquad`
  and `_aggregate_strengths`, about 80 lines, stdlib only); read it
  as one reference implementation. Known defects to fix rather than
  copy: it iterates to a tolerance with no convergence flag instead
  of evaluating a DAG in topological order; float products follow
  edge insertion order; duplicate edges count twice; its tests
  assert inequalities, not exact values. Do not port the workbench,
  its JSON-plus-git store, its branches, or anything that calls an
  LLM.
- `../episteme-v0.6-semantic-core.zip` and `../epistemic/memory`
  (`substrate.py`) — two stdlib-only SQLite event logs with canonical
  JSON, a SHA-256 hash chain, chain verification, and projections
  rebuilt by replay. Both are unsigned (v0.6 has a `signature` column
  that is always NULL, unhashed, and never checked). Take the
  replay-and-rebuild pattern; the signing is what this pilot adds.

## Architecture (use what exists; build only what nobody else can)

Reuse, do not rebuild:
- Veridian wallet, stock app-store build, as the member's key holder.
- demo2's compose stack: KERIA, our witnesses, supporting services.
  Same pinned versions unless a finding says to move.
- demo2's issuer, re-pointed: it now issues a community membership
  credential instead of a scored foundational credential.

Build:
1. Membership credential. ACDC schema with a member handle and
   nothing else that needs inventing. Issued and revocable by the
   community issuer AID. No scores, no roles, no reputation fields.
2. The log. One append-only, hash-chained sequence of entries held by
   the relying party. Each entry is a SAIDed record: author AID,
   SAID of the author's membership credential, kind (`claim`,
   `support`, `attack`), text, target entry SAID (required for
   support/attack, must already be in the log), the author's
   anchoring event (the interaction event from their KEL that seals
   this entry's payload SAID, with its controller signatures and
   witness receipts), and the previous entry's SAID. Because an entry can
   only target an earlier entry, the graph is acyclic by
   construction. The first entry is a genesis record that declares
   the semantics parameters (see 4). The log is the only source of
   truth; any database is a projection that can be deleted and
   rebuilt from it.
3. Gate. The relying party accepts an entry only after, in this
   order and failing closed: signature verifies against the author's
   current key state from their KEL; membership credential chains to
   the community issuer; credential is issued and not revoked in the
   issuer's registry; target exists. Every decision, accept or
   reject, is recorded with the check that failed. No unsigned entry
   is ever written. No code path skips the gate, including ours.
4. Semantics. DF-QuAD over the graph: claims are arguments, support
   and attack entries are edges (and are themselves attackable
   arguments only if that falls out for free — otherwise not). Do
   not invent a scoring scheme: every claim gets the same base
   score, and that number, the aggregation and influence functions,
   and the numeric precision are declared in the genesis entry, not
   hidden in code. The spec says what happens when the same member
   attacks or supports the same target twice. Evaluate in
   topological order — the log guarantees a DAG, so there is no
   iteration and no tolerance. Write the semantics as a short spec with worked
   test vectors. Results must be bit-for-bit reproducible across
   machines and languages — use exact rationals or a stated fixed
   rounding, not bare floats.
5. Web page. Public, read-only view of the graph: each claim with its
   author, its supporters and attackers, its current strength, and a
   link to the raw signed entry. Members post through the same
   wallet-signing flow demo2 established. Plain server-rendered
   pages; no front-end framework. Find out what the wallet requires
   per entry (a full credential presentation each time, or one
   presentation and then one approval per entry) and design for the
   fewest phone steps the wallet allows; report what that is. Claim
   text is free text from real people: demo2 found KERIA truncates
   non-ASCII request bodies and carries a client-side workaround —
   test non-ASCII claims end to end, including from the phone.
6. Independent verifier. A separate command-line program that takes
   an exported log plus the KELs and registry events (or OOBIs to
   fetch them) and nothing else. It re-checks every signature against
   key state, re-checks every membership credential and its
   revocation status, recomputes every strength, and prints a report.
   It shares no code with the relying party: Python on keripy, not
   TypeScript on KERIA — it replays KELs itself, checks witness
   receipts against each author's threshold, checks that each
   credential's registry belongs to the community issuer, and is a
   second implementation of DF-QuAD held to the same test vectors.
   demo2 found no way to query a registry from a Signify client, so
   establish how the export obtains the issuer's registry events and
   say so. The relying party's own gate may keep leaning on KERIA as
   demo2's does, but no chain step may be hard-coded true: a step is
   checked, or it is reported as not checked.
   Build and test the verifier before the relying party's write path.
7. Revocation. The issuer revokes one member's credential. Entries
   that member signs afterward are rejected by the gate and by the
   verifier; their earlier entries remain valid and keep counting.
   DESIGN.md must state exactly what establishes "afterward" — the
   sequence number of the anchoring event in the author's KEL,
   position in the hash-chained log relative to the registry event
   the log operator had seen, a claimed timestamp, or something
   stronger. The author's KEL and the issuer's KEL are separate
   sequences with no shared order, and demo2 already records that
   its revocation check is a best-effort six-second poll. Say what a
   revoked member with a working key, or a dishonest log operator,
   could
   still get away with. Do not paper over this.

Stage 2, only after 1–7 pass on real phones:
8. A member's agent. A member delegates an AID to a software agent
   (Signify client, no phone) which posts entries on the member's
   behalf; the page shows "agent of <member>". Nothing in demo2,
   demo, or Locus creates or approves a delegated AID through
   Signify or KERIA — the only delegation code is Locus's in-process
   keripy proof. First establish from
   Veridian's current source and docs whether the stock wallet can
   approve a delegation at all. If it cannot, report that and stop;
   do not fork the wallet or fake the approval. Note that in KERI,
   removing a delegation anchor by superseding recovery invalidates
   the delegate retroactively (see Locus `proof_recovery.py`), which
   is the opposite of 7 — agent authorization that must end without
   erasing history needs a revocable credential, not de-anchoring.

## Key handling
Member keys are generated and held by the wallet. Issuer and
relying-party keys as in demo2. demo2's runbook is honest that its
pre-rotation answers a leaked signing key only: current and next keys
derive from one passcode file, so losing or leaking that file loses
the issuer, and no restore has ever been drilled. Before any real
member is enrolled, RUNBOOK.md covers, each performed for real on the
test stack: rotating after a signing-key leak; restoring the issuer
from its passcode file plus the KERIA volume onto a fresh box;
restoring a member's wallet from its recovery phrase to the same AID
against this KERIA; and what happens to the community — re-issuance,
re-pinning the trusted issuer, the existing log — if the issuer
passcode is gone for good. If a drill fails, the runbook says so.
Do not commit any passcode, token, or recovery phrase; demo2 has a
tracked `recovery_phrase.txt` and a hardcoded fallback operator token
in `spike/06` — do not copy either.

## Teaching layer (required)
Three lessons, each tied to something visible on a phone or in a
browser:

1. Authorship without accounts. Nobody logged in. Show a claim on
   the page, its raw entry, the signature, and the key event log it
   verifies against. The site has no user table.
2. Disagreement is data. An attack does not delete or hide a claim;
   it is a signed entry of its own. Show B's attack arrive, show A's
   number move, and show the arithmetic that moved it, by hand, from
   the declared parameters.
3. You do not have to trust the host. Download the log, run the
   verifier on a laptop that has never talked to our server's
   application, get the same report. Then change one byte of one
   entry and watch which check fails.

## Non-goals
No LLM anywhere in the stack. No claim extraction, summarization, or
suggestion. No voting, moderation, reputation, standing, or bonds. No
forks or private workspaces. No per-claim base scores or evidence
weighting. No wallet UI work, no custom mobile app, no blockchain or
Cardano backer. No accounts, sessions, or auth other than KERI. No
multi-community support. No deployment beyond one box with compose.

## Deliverables
- README.md for someone who knows KERI but not argumentation: what it
  does, how to run it, what is stubbed.
- RUNBOOK.md: operator setup from zero, issuer key-loss recovery, and
  member revocation, each tested by actually doing it.
- TESTER.md: step-by-step for two non-technical testers with phones.
- WALKTHROUGH.md: the three lessons as prose, problem → intuition →
  term, no jargon before the intuition, for both KERI and
  argumentation terms.
- SEMANTICS.md: the DF-QuAD spec as implemented, the genesis
  parameters, and the test vectors.
- Tests: gate accept/reject for every check; verifier against a
  recorded real log including a tampered copy and a post-revocation
  entry; both DF-QuAD implementations against the vectors; one
  end-to-end test against the live compose stack that runs the
  success criterion with Signify clients standing in for phones. No
  test uses a fake signer or a mocked KEL. If a test is skipped, it
  says so and why.
- DESIGN.md: every place this differs from a production deployment,
  every place Veridian's stack made a decision for us, and every
  design decision you made, each marked "proposed" until I mark it
  decided. Do not write my positions for me.
- LICENSE: Apache-2.0.

## Working style
Run everything; do not describe it. Real KERIA and real witnesses, not
a mock. If the wallet, KERIA, or Signify fights you, report the exact
error rather than working around it silently; if the phone wallet
cannot complete a step, substitute a Signify client, record it as a
known gap, and keep going. Docs describe what the code does — no
novelty or prior-art claims. If a step is stubbed or simplified, the
docs say so. Commit in small steps. Before designing around any
Veridian, KERIA, or Signify behavior, read demo2's findings and then
the component's current docs and source — do not assume from training
data.
