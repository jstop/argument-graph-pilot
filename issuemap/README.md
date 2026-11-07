# issuemap

Turns a long GitHub issue or PR debate into a crux map you can check. Every
claim on the map links to the comment it came from and carries an exact quote,
and each quote is checked mechanically against that comment.

    thread -> claims (exact quotes, verified) -> points (duplicates merged)
           -> links (supports / attacks) -> cruxes (ranked, with sides)

The model acts as a scribe, not a judge. It records and organises the
arguments and names the cruxes, but it never says who was right.

## Run it

Standard library only, Python 3.10+.

    cd tool
    export ANTHROPIC_API_KEY=...          # needed for map / baseline
    python -m issuemap fetch https://github.com/rust-lang/rust/issues/57640 -o thread.json
    python -m issuemap freeze thread.json --suggest           # lists likely summary comments
    python -m issuemap freeze thread.json -o corpus.json --exclude 487758650 457101180
    python -m issuemap map corpus.json -o map.json
    python -m issuemap render map.json -o map.html
    python -m issuemap baseline corpus.json -o baseline.md    # the plain-AI rival

`fetch` uses your `gh` login if the GitHub CLI is installed and signed in.
Otherwise it uses `GITHUB_TOKEN` if that's set, and anonymous access if not.

## Fetching without a laptop

The `issuemap fetch` workflow on this branch fetches threads on GitHub's own
servers. Add issue URLs to `issuemap/requests.txt` (or page URLs to
`issuemap/web.txt`), then push. The JSON lands in `issuemap/data/` about a
minute later.

## Why freeze

Summary comments in a thread are the answer key, not the debate. If the map
sees them, it can copy them. `freeze` writes the exact comments the pipeline
will see, along with a SHA-256 hash, and `map` refuses to run on a corpus whose
hash doesn't match.

## Tests

    python -m pytest tests     # offline: a scripted fake model runs the whole pipeline
