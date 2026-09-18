# DESIGN

What this pilot is, every design decision in it, where Veridian's stack
decided for us, and where it differs from a production deployment. Read
with README.md. Observations were made on the running stack; the scripts
under `spike/` reproduce them. demo2's DESIGN.md findings still hold and
are not repeated in full; the ones that shaped this pilot are cited.

**Every decision below is marked *proposed*. None has been decided by the
owner. Nothing here states the owner's position.**

## Shape

```
 phone (stock Veridian wallet; keys on device)
   │ HTTPS
   ▼
 KERIA (Veridian fork, one process, one agent per phone/service) ── 6 witnesses (ours)
   ▲                         ▲
   │ Signify                 │ Signify
 issuer  ──/registry/*.cesr──▶ relying party: gate → log.jsonl → pages, /export.json
 (TypeScript)                  (TypeScript)                              │
                                                                         ▼
                                           verifier (Python, keripy): export in, report out
```

The log (`log.jsonl`) is the only source of truth. Sessions and gate
decisions are kept beside it; the pages are computed from the log and the
issuer's key event log on every request. Delete everything but
`log.jsonl` and the site renders the same (tested).

## Decisions (all proposed)

### D1. Two layers per entry: payload and record — proposed
The wallet signs by sealing **one digest** in the author's KEL
(demo2: remote-sign). An entry cannot contain its own signature, so:

- **payload** `{d, kind, text, target?, author, credential, log, dt}`:
  what the phone shows and the author approves. `d` is its SAID. Key
  order is the phone's display order. `log` is the genesis record's SAID,
  so an approval cannot be replayed into another log. `dt` is the
  operator's clock at request time and proves nothing; it keeps two
  identical texts from having the same digest.
- **record** `{format, d, n, p, payload, anchor}`: the payload, the
  author's sealing event (`anchor.ked`) with its controller signatures
  and witness receipts (`anchor.atc`), position `n`, and previous record
  SAID `p`. `d` is the record's SAID.

The field is called `format`, not `v`: both signify-ts and keripy read a
top-level `v` as a KERI version string and refuse `arglog/1`.

**Consequence:** the previous-record link is the operator's, not the
author's. The author does not know the head when approving, and putting
it in the payload would make concurrent posts fail and cost a second
phone approval. So authors vouch for *what* they said and *what it
targets*, not for *where in the log* it sits. See D6 for what bounds the
operator.

### D2. Every entry is an argument — proposed
A support/attack entry's `target` is any earlier record. So an attack can
itself be attacked; nothing extra was built for that. The alternative
(edges that are not arguments) would need an invented strength for an
edge. Details, duplicates rule, arithmetic: SEMANTICS.md (all proposed).
Open there, not answered here: whether a member supporting their own
claim should count (it currently does); a cap on graph size (exact
rationals grow: measured 9,842-bit denominator for a width-3 depth-8
tree).

### D3. The genesis record declares the rules, and is signed like any entry — proposed
Record 0 carries community name, the only issuer AID, the schema SAID,
the operator AID and the semantics parameters. The operator seals it in
its own KEL and submits it to the same gate. Both DF-QuAD
implementations refuse parameters they do not implement.

### D4. Gate: fixed order, fail closed, every decision recorded — proposed
`relying-party/src/gate.ts`. Order: request shape → **signature** →
**membership** → **standing** → **target**. First failure stops; a throw
is a failure; the decision (accept or reject, with every check's detail
and *who verified it*) is appended to `decisions.jsonl` **before** the
record is appended to the log. The log file class is not exported; the
only writer is `Gate.submit`. Public at `/decisions`.

What the gate verifies itself versus through KERIA is stated per check:

| Check | By this service | By our KERIA agent (keripy) | Not checked |
|---|---|---|---|
| signature | event at stated sn is the author's `ixn` and contains the digest-only seal of the payload; witness receipts on it are **counted and compared with the author's declared threshold** (demo2 only counted) | the event's signatures against the key state the log establishes; receipt signatures | receipt signatures are not re-verified by us; threshold is the author's *current* one (a member who changed witnesses between events would be judged by the new number; the wallet offers no such operation) |
| membership | issuer, schema, subject = author; registry inception is sealed in the **issuer's** KEL | ACDC digests, issuance event, its anchor, on admit at presentation time | — |
| standing | issuance seal present, **no `{i: credential, s: 1}` seal** in the issuer's KEL, which is pulled fresh through the witnesses for every decision | issuer KEL events and receipts | the revocation TEL event itself is never seen by the relying party (see D5) |
| target | record exists in the log | — | — |

At presentation time the step "presentation is signed by the presenter"
is shown as **not checked by this service** (KERIA delivers only
messages it verified); demo2 showed it as a hard-coded tick. No step is
hard-coded true.

### D5. Revocation is read from the issuer's KEL, not polled from a registry — proposed
Findings (spike/10): without a presentation the relying party's agent
knows nothing about a registry (`/registries/…` 404), and KERIA queries a
registry only while admitting. demo2's six-second poll after admit was
the result. Here the gate looks for the *anchor* instead: a credential's
registry has at most two events, issue (`s=0`) and revoke (`s=1`), and
each must be sealed in the issuer's KEL as `{i, s, d}`. A seal with
`s=1` for a credential is the issuer's witnessed commitment to its
revocation. The relying party can read that through its own agent with
an ordinary key-state query, per decision. It fails closed: if the
issuer's KEL cannot be refreshed, the decision is a rejection.

### D6. What establishes "afterward" — proposed
The author's KEL and the issuer's KEL are separate sequences with no
common order. Candidates and why each is insufficient alone:

- *sn of the author's sealing event*: orders only that author's events.
- *a claimed timestamp*: anyone can claim any time.
- *position in the log relative to what the operator had seen of the
  issuer's KEL* (recorded per decision as `issuerSeen`): true if the
  operator is honest; an operator can understate it.

What is used: **issuer checkpoints**. The issuer's `revoke` first seals
the current log head `{d: <record SAID>}` in its own KEL (event N), then
revokes (event N+1). Because the log is hash-chained, that seal commits
the issuer's witnessed KEL to every record up to that head. Rule, applied
identically by the verifier and by the site's projection:

> An entry citing a credential revoked at issuer event R is valid iff its
> position ≤ the highest log head sealed by the issuer at an event < R.

So "afterward" means: *not inside a log head the issuer sealed before it
sealed the revocation.* The gate's own refusal (D5) is the first line;
this rule is what a third party can check. The verifier also fails the
log if the issuer's KEL seals a head the log does not contain
(truncation or a fork; tested).

**What one can still get away with:**
- *A revoked member with a working key* can keep sealing digests in
  their own KEL forever; nobody can stop that. None of it enters the log
  or counts. They can also still present their credential to anyone who
  does not check the issuer's KEL.
- *Between checkpoint and revocation* (about a second, two consecutive
  issuer events): an entry accepted in that gap is rejected by the rule
  although the gate accepted it. The site applies the same rule, so site
  and verifier agree; the entry shows as not counted.
- *Revoking without a checkpoint* (`--no-checkpoint`, or an issuer not
  using our tool): every entry of that member after the previous
  checkpoint is rejected, including honest ones. Fail-closed, and it
  costs history. The CLI refuses to do this unless told to.
- *A dishonest log operator* can: refuse or delay entries (censorship);
  reorder entries that are after the last checkpoint, within the limit
  that a target must precede what targets it; show different tails to
  different people until the next checkpoint; drop the tail after the
  last checkpoint. It cannot forge, alter or re-attribute an entry, move
  anything at or before a checkpoint, or make a revoked member's later
  entry count.
- *Operator and issuer are the same party here.* A checkpoint is the
  issuer vouching for the operator's log; if both are dishonest together
  the ordering guarantee is void (they can checkpoint a rewritten
  history before anyone downloads the old one; anyone holding an earlier
  export can show the fork). Membership already rests on the issuer.
- Checkpoints happen only on revocation (and on `main.ts checkpoint`).
  Nothing checkpoints on a schedule. Between them the tail rests on the
  operator alone.

### D7. How the export obtains the issuer's registry events — proposed
demo2 found no registry query for a Signify client. Established here
(spike/10): the **issuer's own agent** exports a credential as CESR
(`credentials().get(said, true)`) containing the issuer's full KEL, the
registry inception, the credential's iss/rev events with witness
receipts, and the ACDC. The issuer serves that at
`GET /registry/<SAID>.cesr` (public; refuses anything it did not issue).
`/export.json` = the log + KELs of operator, issuer and authors from the
relying party's agent + those CESR exports, passed through unread. The
verifier trusts none of it; keripy re-verifies every event. A third
person can fetch the `.cesr` files from the issuer directly instead.
**Not built:** fetching by OOBI from witnesses inside the verifier (the
brief allowed either; the verifier takes the export file only).
Withholding: an export that leaves out a `rev` event cannot hide the
revocation, because the issuer's KEL carries the `{i, s: 1, d}` seal for
it; the verifier reads revocation from that seal as well as from the
registry and reports the withheld event (tested on the recorded log).

### D8. Fewest phone steps — proposed; this is what the wallet allows
From the wallet's source (v1.2.0 = submodule `ed015b1`; identical files
in store tag 1.2.2) and confirmed live (spike/10): a signing request
needs only that the requester can reach the wallet's agent. No
presentation, no contact check, no expiry, no count. Per signing request
the phone steps are: open the notification → **Sign** → passcode or
biometric. So:

- first visit ever: scan QR → share credential (the wallet's two
  approvals) → Sign;
- later entries in the same browser session: **Sign** only;
- later visits: scan QR → Sign. The relying party's agent still holds
  the credential it verified, and standing is re-read from the issuer's
  KEL each time, so no second presentation.

The relying party still requires one presentation per member, because
it needs the ACDC itself to check membership.

### D9. Independent verifier — proposed
Python on keripy 1.3.5, no code shared with the services. Started from
`../demo/osmio_demo/verification.py`; keeps its three fixes (bounded
parse; never reading `reger.saved` as "valid"; registry owner = issuer
and issuance anchor re-derived from the issuer's KEL).
`Kevery(lax=False, local=False)` enforces witness thresholds: a real
recorded event cut to 3 of 4 required receipts is not accepted (tested).
Without `--issuer` the report says the issuer was **not checked** (taken
from genesis).

### D10. A personal layer: attention, fed by your own library and the community — proposed; changes the brief's scope
Added at the owner's request after the first phone run. The brief's
non-goals say "no suggestion" and "no reputation". `personal/` **suggests
what to look at**. It is confined to the owner's machine and adds nothing
to the community stack: the services, the log format, the gate and the
verifier are unchanged except that the posting page accepts `?text=` to
prefill its box (nothing is sent until the member clicks and signs). No
LLM is called; links between your ideas and community entries are made by
hand. The owner should decide whether the non-goal stands as written.

- **Reads a personal Episteme library** (`~/workspace/epistemic`)
  strictly read-only: SQLite opened `mode=ro`, then Episteme's *own*
  replay and stance code run on that connection, so its rules (stance
  ladder, dependency cap, "unreviewed is capped at NOTE") are not
  re-implemented. Episteme's own constructor is not used because it
  writes on open. Tested on a read-only file; never writes there.
- **Takes the community in only through the independent verifier.** A
  pulled export is verified against an issuer identifier the owner
  supplies; entries that fail exert no pressure (tested with a rewritten
  attack). The site's own numbers are not used.
- **Attention, not confidence.** `score = weight × Σ signals`. Weight is
  structural (how many of your ideas rest on this one) adjusted by your
  own "A over B" comparisons and halved per dismissal. Signals are named
  and printed: a fresh community attack on something you hold (+3), a
  compromised premise (+2.5), a divergence between your stance and the
  community standing (+1.5…2), SUSPECT/CONTESTED/HYPOTHESIS in your own
  library, heavy-and-never-examined, and an outward suggestion (a
  position you stand behind, in a topic already argued there, that
  nobody has claimed). An idea with no signal is not shown. One seat is
  always kept for a community claim linked to nothing you hold. All the
  point values are guesses to be tuned against use.
- **A community strength is never converted into your confidence.** It
  says how a claim stands among the members who showed up. It appears
  only as pressure where it diverges from your stance.
- **What it remembers** (links, comparisons, your responses, which
  exports it pulled) is its own hash-chained JSONL under
  `~/.local/share/arglog-focus`, rebuilt by replay; not in the repo, not
  in Episteme.
- **Privacy.** Your ideas are printed to your terminal or served on
  127.0.0.1. The only thing that leaves is text you yourself post and
  sign. `personal/` is not deployed to the cloud box.
- **Zoom in (`focus why KEY`, page `/why`).** Every rule leaves a record
  for every idea whether it fired or not, with the inputs it looked at
  and, if not, why not (tested: no rule may be missing from a trace).
  The trace then goes down: the weight's arithmetic; what the library
  holds behind the idea (stance and Episteme's reason for it, who wrote
  and who stands behind the wording, premises with their stances, what
  rests on it, evidence with author and recorder, grounding quotes);
  for each linked community entry, the verifier's own five checks and
  the responses to it; and what you did with the item before.
- **The pipeline is declared, not coded** (`focus pipeline`): weights,
  points, thresholds, budget, as JSON identified by its SHA-256. Unknown
  keys are refused; a rule at 0 is off and says so in traces. The active
  pipeline is the last `PipelineAdopted` event, which carries the full
  text. The rules' *logic* is still Python; only their numbers are data.
- **Every list shown is recorded with its coordinates**: pipeline
  digest, library position (event sequence and hash), community export
  digest, date, result. Identical consecutive lists are recorded once.
  `focus audit` (page `/history`) recomputes every recorded list from
  those coordinates: the library is append-only so it is replayed *as
  of* that sequence, exports are kept by digest, the focus log is
  replayed up to the list's own position. A list that no longer
  reproduces means something rewrote its past (tested across the
  library growing and a pipeline change). Limit: Episteme's stance code
  is whatever is installed today, so a change to *its* rules shows up as
  lists that stop reproducing, without saying which rule.
- **Testing a change** (`focus try`, `focus replay`): `try` shows
  today's list under the candidate next to the active one, with which
  rule moved each item. `replay` runs the candidate over every recorded
  list and tallies it against what you did next: does it keep showing
  what you engaged with and stop showing what you dismissed. That is a
  small, biased sample (you only responded to what the old rules showed
  you) and the tool says so. Nothing tunes itself.
- **Not built:** maturity (exploring/developing/settled) as its own
  axis, since Episteme has no such field (HYPOTHESIS is the nearest);
  writing anything back into Episteme (e.g. a community entry as
  evidence, a record that you published a belief); workbench argument
  graphs as a source of weight; any automatic matching of ideas to
  entries; the content of evidence in the trace (it shows identity,
  author and grounding quotes, not the document).

## Where Veridian's stack decided for us

Everything in demo2's list still applies (six witnesses marked
`?role=witness`, KERIA fork, signify-ts at the wallet's commit, CommonJS,
indexer role for issuer *and* requester, frozen per-agent config,
introductions, remote signing, onboarding `/connect`, presentation
dialect, traefik pin). New here:

- **The phone shows one truncated line per field.** The signing screen
  renders each payload value with `white-space: nowrap; text-overflow:
  ellipsis`, no way to expand, newlines collapsed
  (`RemoteSignRequest.scss`). The author signs the whole text and sees
  the start of it. We cannot change the wallet. Mitigation: the browser
  page shows the full text and says so; text is capped at 500
  characters. **Untested on a real phone.**
- **Field labels**: the wallet hides `d`, splits camelCase keys into
  words, relabels `i`/`dt`/`s`. Payload keys are plain words for that
  reason. Booleans and null render empty; the payload has only strings.
- **Location publishing fails after an interaction event.**
  `addLocScheme` → `400 unable to verify end role reply message`
  whenever the identifier's latest key event is an `ixn`; works after
  `icp` or `rot` (spike/14 prints the matrix). Found by the
  issuer-restore drill: the issuer lost its local "already published"
  note with its volume and could never start again. Both services now
  ask KERIA what is published and skip if unchanged; changing a public
  URL requires rotating first, and the error says so.
- **Two filter keys match nothing.** `credentials().list({filter:
  {"-i":…, "-s":…}})` returns `[]` while each key alone matches. Both
  services filter by one key and check the rest in code.
- **Shared-network DNS.** Our compose services share Veridian's docker
  network; demo2's containers named `issuer`/`relying-party` on the same
  network captured those names and our schema OOBI timed out. Ours are
  `arglog-issuer`/`arglog-log`.
- **Delegation: the stock wallet cannot approve one.** See Stage 2.

## Bugs carried from demo2, status here

1. KERIA truncates non-ASCII request bodies: workaround kept
   (`installAsciiJsonBodies`). Non-ASCII claims and handles are tested
   end to end with stand-ins, including SAID agreement between
   signify-ts and keripy. **From a real phone: not yet tested.**
   demo2's HTTP body reader concatenated chunks as strings, which can
   split a multi-byte character; both services now join bytes first.
2. Any client can crash the shared KERIA: unchanged, not worked around.
3. `KERIA_PASSCODE=CHANGEME`: `stack.sh` still generates a real one.
4. New: demo2's `.gitignore` had `*.local`, which excluded
   `infra/env.local`; a fresh clone could not run `stack.sh`. Tracked
   here. demo2's image ran `npm ci --omit=dev` but started with `tsx`, a
   dev dependency, so every container start downloaded it; `tsx` is a
   dependency here.

## Where this differs from production

demo2's table applies unchanged for: witness pool, single shared KERIA,
issuer key custody, witness keystores, KERIA passcode, operator auth,
session bearer URLs, schema hosting, deployment. Additional:

| Area | Pilot | Production would |
|---|---|---|
| Log storage | One JSONL file, one process, appends serialized in memory. | Replicated store; the record format would not change. |
| Log integrity beyond the operator | Issuer checkpoints on revocation only. | Periodic checkpoints by parties other than the operator (members, watchers), or a transparency log. |
| Operator = issuer | Same box, same operator. | Different parties. |
| Verifier input | One export file produced by the operator (plus the issuer's CESR). | Fetch KELs from witnesses/watchers chosen by the verifier; detect duplicity. No watchers here: an issuer colluding with its witnesses is not detected. |
| Revocation freshness | Issuer KEL pulled through the shared witnesses per decision. | Same, with independent witnesses. |
| Moderation | None; entries are permanent (non-goal). | — |
| Sybil resistance | One credential per scan of an operator QR. Whoever the operator enrols twice counts twice. | Whatever the community's admission process is. |
| Size | Exact rationals, no cap (SEMANTICS.md open item). | A declared bound or fixed rounding. |

## Stage 2 (a member's agent): stopped, as instructed

Established from the wallet's source at `ed015b1` (= main; store build
1.2.2 identical in the relevant files): the wallet has **no delegator
capability**: no service method, no UI, no notification route. The only
`.interact()` in the app is remote-sign, whose seal is hard-coded to
`{d}`, so it cannot produce a delegation seal `{i, s, d}`. Its own UI
text says delegation "is currently being developed". signify-ts
(`delegations().approve`) and the KERIA fork (`DelegatorEnd`) do support
approval, from a Signify client that is not the wallet. Per the brief:
reported, nothing built, wallet not forked, approval not faked.

Note for when it becomes possible: removing a delegation anchor by
superseding recovery invalidates the delegate for any *fresh* verifier
(Locus `proof_recovery.py`; that proof does not show a verifier that had
already accepted the delegate dropping it). That is the opposite of D6's
"earlier entries keep counting", so ending an agent's authority without
erasing its history needs a revocable credential checked under D6, not
de-anchoring.

## Stubs, simplifications, and what has not been done

- **No real phone has run any of this.** Everything "tested" above used
  `wallet-standin.ts`, a Signify client that copies the wallet's calls.
  TESTER.md is unexecuted. The success criterion is met with stand-ins
  against local containers and against the cloud deployment (RUNBOOK
  §1a).
- Wallet recovery from a phrase: drilled only in stand-in form.
- Issuer restore: drilled onto a fresh data volume against the **same**
  KERIA volume on the same machine, not onto another host.
- The verifier has no OOBI/witness fetch mode (D7).
- Verifier fixtures lack two adversarial recordings (someone else's
  credential; a registry not owned by the issuer). The first is covered
  live at the gate; the second only by the code path inherited from
  `../demo`, whose own tests cover it without witnesses.
- Taken as ideas only: Locus's fixed-order fail-closed gate with a
  receipt per decision (its `int(failed) if failed else None` bug, which
  loses error code 0, was not copied); the replay-and-rebuild pattern of
  the two SQLite event logs. No code from Locus, the workbench, or the
  event logs is in this repo; no LLM is called anywhere.
