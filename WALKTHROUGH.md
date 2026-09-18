# Three lessons, each with something to look at

For two kinds of reader: people who work on argumentation and
epistemology and know neither KERI nor public-key infrastructure, and
KERI people who do not know argumentation. Each idea comes in the same
order: the problem, then a picture of the answer in ordinary words, then
where to look on the running site, and only then the technical term.
If you already know the term, skip to "What to look at".

## Lesson 1. Authorship without accounts

**The problem.** A sentence on a web page says "Ana wrote this". Why
believe it? Normally because Ana has an account, the site checked her
password, and the site says so. The site can therefore also put words in
Ana's mouth, edit them later, or lose the account table to a thief. The
attribution is only as good as the host.

**The intuition.** Every participant keeps a notebook that only they
can write in: each line is signed with a key that lives on their phone,
and a handful of independent clerks countersign each line, so the owner
cannot later produce a different line 7. To say something in public,
Ana writes one new line in her own notebook: "I stand behind the text
whose fingerprint is X". The site keeps the text and a copy of that
line. Anyone can recompute the fingerprint from the text and look for
it in Ana's notebook. The site never holds anything that would let it
write there.

And "Ana"? The notebook has no name in it, only a long code. A separate
party, the community's membership secretary, has given that code a
signed card saying "this is a member, shown as Ana". The name on the
page comes from the card.

**What to look at.** Open `/` and tap *signed entry, and how the number
was computed* under any entry. That is `/entry/<SAID>`. From the top:

- *Who said this*: the long code, a link to its notebook, and the card
  the name comes from.
- *What the phone showed and the author approved*: the text together
  with a few fields (what kind of entry, what it responds to, who, which
  card, which log). Its first line, `d`, is the fingerprint of the rest.
- *The signature*. Read this one honestly: **the phone did not sign the
  text.** It added a line to the author's own notebook, and that line
  contains the fingerprint `d`. The line is signed with the author's
  current key and countersigned by the clerks. The page shows the line
  and, below it, the signatures and countersignatures as raw text.
- *What this site's gate checked before writing it*: four checks, each
  labelled with who actually did the checking. The site does not verify
  signatures in its own code; its backend service does, and the page
  says so. Lesson 3 is about not having to rely on that.

Follow the link to `/kel/<AID>`: the author's whole notebook. Line 0
creates the identifier and names its first key and its clerks. The line
cited on the entry page is further down, and you can find `d` inside it.

On the phone the same moment is: a notification, a screen listing the
fields, **Sign**, a PIN or fingerprint. The phone shows only the start
of a long text, on one line; the author signs the whole text.

**No user table.** The site keeps four files: `log.jsonl` (the
entries), `decisions.jsonl` (every accept and reject, shown at
`/decisions`), `sessions.json` (short-lived posting sessions: a random
id, and once a phone has scanned, that phone's identifier and handle),
and `operator.bran` (the passcode for the site's *own* identifier). No
passwords, no member secrets. One thing it does remember, in its
backend service rather than in a file of its own: a card it has already
checked. That is why a returning member is not asked to show it again.
The pages are computed from `log.jsonl` and the secretary's notebook on
every request.

**The terms.** The long code is an *identifier* (KERI: *AID*). The
notebook is its *key event log* (*KEL*); line 0 is the *inception
event*; the code is derived from line 0, so nobody can claim it with a
different first line. The clerks are *witnesses*; a countersignature is
a *receipt*; how many are needed is declared in the log itself. A
fingerprint is a *digest*; a record that carries its own digest as its
name is said to have a *SAID* (self-addressing identifier), which is
what the 44-character codes in the URLs are. Putting a digest into a
notebook line is a *seal*, and the text is then *anchored* in the log.
The card is a *credential* (*ACDC*); the secretary is the *issuer*.
The four checks are the *gate*. The backend service is *KERIA*.

## Lesson 2. Disagreement is data

**The problem.** On most platforms, disagreement with a statement
either sits beside it as a comment that changes nothing, or it acts on
the statement: flags, downvotes, removal. In the first case the
disagreement has no effect; in the second, the original disappears and
nobody can see what was objected to, by whom, or why.

**The intuition.** Here an objection is just another signed entry that
points at the one it objects to. Nothing is removed. What changes is a
number next to the target. Every entry starts at the same number, one
half. An objection pulls its target toward 0; a reason in favour pulls
it toward 1; and each pulls only as hard as its own current number. So
an objection that has itself been objected to pulls less. The rules are
few enough to do on paper, and they are written in the log, not hidden
in the site's code.

**What to look at.** Tester A's claim appears on `/` at **0.5000**.
Tester B taps *Attack*, writes a reason, signs on the phone. Reload `/`:
A's claim is still there, word for word, now at **0.2500**, with B's
entry indented beneath it at 0.5000. Open A's `/entry/<SAID>` and read
*The number, by hand*:

- Starts at 1/2.
- Attackers: B's entry, at 1/2. Combined pull = 1 − (1 − 1/2) = 1/2.
- Supporters: none, so 0.
- Attack is stronger by 1/2: 1/2 − 1/2 × 1/2 = **1/4**.

Now someone supports A's claim. The supporter is a new entry at 1/2.
Attack pull 1/2, support pull 1/2: they are equal, so the claim goes
back to its starting value, **1/2**.

Now take the supporter away again and instead let someone attack *B's
attack*. Work from the newest entry backwards. The new entry: 1/2. B's
attack now has one attacker at 1/2, so it drops to 1/2 − 1/2 × 1/2 =
1/4. A's claim now has one attacker at 1/4: 1/2 − 1/2 × 1/4 = **3/8**
(0.3750). Attacking the attacker gives A's claim back some of what it
lost, not all of it.

With several: the combined pull of a group is 1 − (1 − v₁)(1 − v₂)…, so
two attackers at 1/2 pull with 3/4, not 1. If attack is stronger by x,
the result is start − start × x; if support is, start + (1 − start) × x.
Numbers are exact fractions; the four decimals are for display only.
SEMANTICS.md has sixteen cases worked by hand.

Two declared rules worth knowing:

- *Where the parameters are.* The starting value, the two formulas, the
  exact-fraction arithmetic and the rounding are named in the log's
  first record (linked from the bottom of `/`). Both programs that
  compute numbers refuse a log whose parameters they do not implement.
- *Duplicates.* If the same member attacks the same entry twice, only
  the first counts toward the target. The second is still shown, still
  has its own number, and is marked as not counting. One member
  supporting *and* attacking the same entry: both count. A member
  supporting their own claim currently counts too; SEMANTICS.md lists
  that as an open question.

An entry can only point at an earlier one, so nothing goes in a circle
and one pass from newest to oldest computes everything.

**The terms.** Each entry is an *argument*. An entry pointing at another
is an *attack* or a *support*. The starting number is the *base score*;
the current number is the *strength*. A method that gives arguments
degrees of strength instead of accepted/rejected is a *gradual
semantics*; this one is *DF-QuAD* (Rago, Toni, Aurisicchio, Baroni,
2016). "Combined pull" is its *aggregation* function; the last step is
its combination (or influence) function. The third worked case is
called *reinstatement*. All entries get the same base score; there is
no weighting by author.

## Lesson 3. You do not have to trust the host

**The problem.** Everything so far was shown to you by the site. A site
can show anything. Lesson 1 said the site does not even verify
signatures in its own code. So why believe its page?

**The intuition.** You do not need to. Every entry carries its own
evidence: the text, its fingerprint, the author's notebook line, the
clerks' countersignatures, the secretary's card. Put all of that in one
file, give it to someone with a different program, written by reading
the rules rather than by copying the site, and let them redo every
check and every sum. If they get the same authors and the same numbers,
the host's honesty did not matter for those facts.

**What to look at.** `/verify` gives the commands. `/export.json` is the
file: the log, the notebooks of everyone who wrote in it, and the
secretary's records for each card. The program is in `verifier/`. It
reads the file and talks to nothing; carry the file over on a USB stick
if you like. The one thing to obtain from somewhere other than the site
is the secretary's identifier (`--issuer`). Without it, the report says
so: `NOT CHECKED community issuer`.

The terminal report has a `LOG` section (the first record, the declared
parameters, the secretary's notebook), then under `ENTRIES` each entry
with its author, its text, five checks (`record`, `signature`,
`membership`, `standing`, `target`) and its strength, then a `RESULT`
line. Compare with `/`: same handles, same `0.2500  (exactly 1/4)`.

*Change one byte.* Open `export.json`, change one letter of A's claim,
run again. A's entry now reads `FAIL record: record does not hash to
its identifier; payload does not hash to its identifier`. The
fingerprint no longer matches the text. B's attack fails at `target`:
what it pointed at is no longer a valid entry. `RESULT: FAILED`.

*The smarter forgery.* A forger who understands this recomputes the
fingerprint of the altered text, then the record's, then re-links every
later record. Now `record` passes. The entry fails one step later:
`FAIL signature: event #N does not seal <new fingerprint>`. Ana's
notebook line still contains the old fingerprint, and the forger cannot
write a new line in her notebook. (If the secretary has ever sealed a
position of this log, see below, the re-linked log also fails the
log-level check `log contains every head the issuer checkpointed`.)

The verifier replays each notebook itself. A line exists for it only if
it was signed by the key current at that point and carries at least the
number of countersignatures its owner declared.

### Revocation, and what "afterward" means

**The problem.** The secretary withdraws Ana's card. What Ana signed
while she was a member should keep counting; what she signs afterward
should not. But "afterward" by whose clock? Ana's notebook and the
secretary's notebook are separate. Each is ordered within itself;
nothing orders a line in one against a line in the other. A timestamp
is only a claim. The site's log has an order, but the site's operator
decides it.

**The intuition.** Before withdrawing the card, the secretary writes one
line in its own notebook: "the argument log, as of now, ends at the
record with fingerprint H". Then, on the next line, the withdrawal.
Every record in the log contains the fingerprint of the one before it,
so naming H pins down everything up to H. The rule follows: an entry
citing a withdrawn card counts only if it lies at or before the last
position the secretary wrote down *before* the withdrawal line.
Anything later does not count: it was either signed after the
withdrawal or cannot be shown to have been signed before it.

**What to look at.** Withdrawal is an operator action on the issuer
page, not part of the two-phone test. After it: the member's earlier
entries on `/` keep their numbers; a new attempt from that phone ends
with the posting page saying *Rejected: membership has been revoked*,
or, if the member was already past that step, appears on `/decisions`
as `reject at check standing`. Either way nothing is written to the
log. The verifier's report shows earlier entries with `this entry is
inside the log head the issuer sealed before revoking`. The site checks
the secretary's notebook afresh for every decision and refuses the
entry if it cannot.

**The terms.** Withdrawing a card is *revocation*. The secretary's list
of issued and revoked cards is a *registry*; each of its events is
anchored by a seal in the issuer's KEL, and that seal is what the gate
and the verifier look for. The written-down position is a *checkpoint*
(DESIGN.md D6: checkpoint, then revoke).

**What one can still get away with.** Plainly:

- A revoked member still has a working key. They can go on adding lines
  to their own notebook forever, and show their card to anyone who does
  not check the issuer's log. None of it enters this log or counts.
- An honest entry accepted in the second or so between the checkpoint
  line and the revocation line is shown as not counting, although the
  gate accepted it.
- If the issuer revokes without a checkpoint, every entry by that
  member after the previous checkpoint stops counting, honest ones
  included; with no earlier checkpoint, all of them. The tool refuses
  to do this unless told to.
- Checkpoints happen only at revocation or when the operator asks for
  one. Between them, the newest entries rest on the operator alone.
- A dishonest host can refuse or delay entries; reorder entries that
  come after the last checkpoint (a target must still come before what
  targets it); show different recent entries to different people; drop
  everything after the last checkpoint. It cannot forge, alter or
  re-attribute an entry, move anything at or before a checkpoint, or
  make a revoked member's later entry count.
- In this pilot the host and the issuer are the same operator. If that
  one party is dishonest in both roles, it can checkpoint a rewritten
  history (reordered, or with entries dropped; still not forged); only
  someone holding an earlier export can show the difference.
- The verifier reads the file it is given. It does not fetch notebooks
  from the witnesses, and there are no independent observers comparing
  copies, so an issuer colluding with its own witnesses is not detected.

## What was not shown

- **No real phone yet.** Everything described here has run with a
  program standing in for the phone wallet, making the calls the wallet
  makes. TESTER.md has not been executed. How the phone renders the
  signing screen, including non-ASCII text, is unobserved.
- **Stage 2, a member's software agent, was stopped.** Letting a
  program post on a member's behalf needs the member's wallet to
  approve it (KERI: a *delegation*), and the stock wallet has no way to
  do that (DESIGN.md, "Stage 2"). Nothing was built, nothing was faked.
- **The same operator runs the issuer and the log**, on one machine,
  with witnesses that are also ours.
