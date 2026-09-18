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

`--branch dev` reads Episteme's dev build. Tests: `python -m pytest -q`
(a temporary Episteme library built with Episteme's own code, and the
community log recorded from the live stack; skipped, saying so, if
Episteme is not on the machine).
