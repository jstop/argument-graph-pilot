# focus: what deserves your attention

Personal side of the pilot. It reads **your own** Episteme library
(`~/workspace/epistemic`, read-only) and the **community** argument log
(only after verifying it independently), and prints a short list: what is
most worth your attention now, the reasons, and what you could do. It
runs on your machine and serves on 127.0.0.1 only. Rules and limits:
DESIGN.md D10 (all proposed).

```
cd personal && source <the venv with verifier/requirements.txt>
python -m focus pull https://claims.<domain> --issuer <issuer AID>   # fetch + verify the community log
python -m focus                                                      # the list, with reasons
python -m focus serve                                                # same, as a page: http://127.0.0.1:3130/
```

Tie your ideas to the community by hand (nothing guesses for you):

```
python -m focus entries                     # verified community entries: SAID, standing, text
python -m focus ideas water                 # find your idea's id
python -m focus link <idea> <SAID> same     # "that entry says what I hold"   (or: opposes)
```

From then on an attack on that entry shows up as pressure on your idea,
weighted by how much of your thinking rests on it, with a link that opens
the community site's "attack" page for your phone to sign. Tell it what
you did, and what matters more:

```
python -m focus engage <idea>       python -m focus snooze <idea> 30
python -m focus dismiss <idea>      python -m focus over <ideaA> <ideaB>
```

## The page does all of it

`python -m focus serve` → http://127.0.0.1:3130/ . Everything below in this
file can be done there: **Community** (pull and verify, see entries, link
and unlink), **My ideas** (find, open, rank one over another), every
item's **how this got here** page (trace, respond, link, compare),
**Rules** (edit the numbers, try, replay over your history, adopt),
**History** (every list shown, re-audited). The page and the terminal can
be used at the same time; they write one locked, hash-chained log. Forms
carry a per-start token and the server answers only to 127.0.0.1, so
another website open in your browser cannot operate it.

## Zoom in, look back, try changes

```
python -m focus why <idea>          # everything behind one item: the arithmetic, EVERY rule (fired or not, on
                                    # what inputs, and why not), what your library holds behind it (evidence,
                                    # authorship, premises), what the verifier found about each linked entry
python -m focus pipeline > my.json  # the rules' numbers, as a file. Edit it. A typo is refused; 0 turns a rule off
python -m focus try my.json         # today's list under your rules vs the active ones, and which rule moved what
python -m focus replay my.json      # your rules over every list ever shown, against what you then did
python -m focus adopt my.json why   # make it active; recorded with its full text
python -m focus history             # every list shown and what it was computed from
python -m focus audit               # recompute each of them from those coordinates; says if one no longer reproduces
```

The page has the same: "how this got here" on every item, `/pipeline`,
`/history`.

`--branch dev` reads Episteme's dev build. Tests: `python -m pytest -q`
(a temporary Episteme library built with Episteme's own code, and the
community log recorded from the live stack; skipped, saying so, if
Episteme is not on the machine).
