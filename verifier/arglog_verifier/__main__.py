"""
    python -m arglog_verifier EXPORT.json [--issuer AID] [--json]

Reads one exported log and prints who said what, which checks each entry
passed, and every strength recomputed from the parameters the log's genesis
entry declares. Talks to nothing. Exit status 0 only if every log-level
check and every entry passed.
"""
import argparse
import contextlib
import io
import json
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(prog="arglog_verifier", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="path to an export (arglog-export/1 JSON)")
    ap.add_argument("--issuer", help="the community issuer AID you were given out of band; without it the genesis entry's is used and reported as not checked")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    args = ap.parse_args(argv)

    with open(args.export, "rb") as f:
        bundle = json.loads(f.read().decode("utf-8"))

    from .verify import verify_bundle  # keripy import is slow and prints; keep --help fast
    noise = io.StringIO()
    with contextlib.redirect_stdout(noise):  # keripy prints progress lines from library code
        rep = verify_bundle(bundle, trusted_issuer=args.issuer)

    if args.json:
        print(json.dumps({
            "ok": rep.ok, "log_checks": rep.log_checks, "not_checked": rep.not_checked,
            "entries": [{"n": e.n, "said": e.said, "kind": e.kind, "author": e.author, "handle": e.handle, "ok": e.ok,
                         "failed": e.failed, "checks": e.checks, "strength": rep.strengths.get(e.said, {}).get("strength"),
                         "display": rep.strengths.get(e.said, {}).get("display"), "counted": rep.strengths.get(e.said, {}).get("counted")}
                        for e in rep.entries]}, indent=1, ensure_ascii=False))
        return 0 if rep.ok else 1

    mark = lambda ok: "ok  " if ok else "FAIL"
    print("LOG")
    for name, ok, detail in rep.log_checks:
        print(f"  {mark(ok)} {name}: {detail}")
    for note in rep.not_checked:
        print(f"  NOT CHECKED {note}")
    texts = {e["d"]: e["payload"] for e in bundle["log"][1:] if isinstance(e, dict) and isinstance(e.get("payload"), dict)}
    print("\nENTRIES")
    for e in rep.entries:
        p = texts.get(e.said, {})
        s = rep.strengths.get(e.said)
        head = f"#{e.n} {e.kind}" + (f" -> #{next((x.n for x in rep.entries if x.said == p.get('target')), '?')}" if p.get("target") else "")
        print(f"  {head}  by {e.handle or '?'} ({(e.author or '?')[:12]}…)  {e.said}")
        print(f"      \"{p.get('text', '')}\"")
        for name, ok, detail in e.checks:
            print(f"      {mark(ok)} {name}: {detail}")
        if s:
            print(f"      strength {s['display']}  (exactly {s['strength']})" + ("" if s["counted"] else "  [duplicate: does not count toward its target]"))
        else:
            print(f"      REJECTED at check '{e.failed}': not an argument, no strength")
    print(f"\nRESULT: {'every check passed' if rep.ok else 'FAILED'}; {sum(e.ok for e in rep.entries)} of {len(rep.entries)} entries valid")
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
