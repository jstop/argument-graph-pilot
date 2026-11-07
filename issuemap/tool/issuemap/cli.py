"""issuemap: turn a long GitHub issue debate into a checkable crux map.

  python -m issuemap fetch  <issue-url> -o thread.json
  python -m issuemap freeze thread.json -o corpus.json [--exclude ID ...]
  python -m issuemap map    corpus.json -o map.json
  python -m issuemap render map.json -o map.html
  python -m issuemap baseline corpus.json -o baseline.md
  python -m issuemap all    <issue-url> -d outdir

fetch uses the GitHub CLI's login if `gh` is installed and signed in, else
GITHUB_TOKEN if set, else anonymous access. map/baseline need ANTHROPIC_API_KEY.
"""
import argparse
import json
import os
import sys

from . import corpus as corpus_mod
from .github import fetch_thread
from .render import render_file


def _dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def _load(path):
    with open(path) as f:
        return json.load(f)


def main(argv=None):
    p = argparse.ArgumentParser(prog="issuemap", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("url"); f.add_argument("-o", default="thread.json")
    z = sub.add_parser("freeze"); z.add_argument("thread"); z.add_argument("-o", default="corpus.json")
    z.add_argument("--exclude", nargs="*", default=[]); z.add_argument("--reason", default="")
    z.add_argument("--suggest", action="store_true", help="only list likely summary comments")
    m = sub.add_parser("map"); m.add_argument("corpus"); m.add_argument("-o", default="map.json")
    m.add_argument("--model")
    r = sub.add_parser("render"); r.add_argument("map"); r.add_argument("-o", default="map.html")
    b = sub.add_parser("baseline"); b.add_argument("corpus"); b.add_argument("-o", default="baseline.md")
    b.add_argument("--model")
    a = sub.add_parser("all"); a.add_argument("url"); a.add_argument("-d", default="issuemap-out")
    a.add_argument("--exclude", nargs="*", default=[]); a.add_argument("--model")
    args = p.parse_args(argv)

    if args.cmd == "fetch":
        t = fetch_thread(args.url)
        _dump(t, args.o)
        print(f"{len(t['comments'])} comments -> {args.o}")
        for s in corpus_mod.suggest_exclusions(t):
            print(f"  possible summary comment {s['id']} by {s['author']}: {s['preview']}")
    elif args.cmd == "freeze":
        t = _load(args.thread)
        if args.suggest:
            for s in corpus_mod.suggest_exclusions(t):
                print(json.dumps(s, ensure_ascii=False))
            return
        c = corpus_mod.freeze(t, args.exclude, args.reason)
        _dump(c, args.o)
        print(f"frozen {c['frozen']['comment_count']} comments, sha256 {c['frozen']['sha256']}")
    elif args.cmd in ("map", "baseline", "all"):
        from .llm import Claude, DEFAULT_MODEL
        from . import pipeline
        model = Claude(model=args.model or DEFAULT_MODEL)
        if args.cmd == "all":
            os.makedirs(args.d, exist_ok=True)
            t = fetch_thread(args.url)
            _dump(t, f"{args.d}/thread.json")
            c = corpus_mod.freeze(t, args.exclude)
            _dump(c, f"{args.d}/corpus.json")
            mp = pipeline.run(c, model)
            _dump(mp, f"{args.d}/map.json")
            render_file(f"{args.d}/map.json", f"{args.d}/map.html")
            print(f"done: {args.d}/map.html ({model.calls} model calls, {model.usage})")
            return
        c = _load(args.corpus)
        if not corpus_mod.verify_frozen(c):
            sys.exit("corpus hash does not match its contents; refusing to run")
        if args.cmd == "map":
            _dump(pipeline.run(c, model), args.o)
        else:
            with open(args.o, "w") as fh:
                fh.write(pipeline.baseline(c, model))
        print(f"-> {args.o} ({model.calls} model calls, {model.usage})")
    elif args.cmd == "render":
        render_file(args.map, args.o)
        print(f"-> {args.o}")


if __name__ == "__main__":
    main()
