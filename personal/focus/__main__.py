"""
    python -m focus                          what deserves your attention now, and why
    python -m focus pull URL --issuer AID    fetch the community export, verify it independently, keep it
    python -m focus ideas [words]            find ideas in your library     (id  stance  claim)
    python -m focus entries                  the verified community entries (SAID  strength  text)
    python -m focus link IDEA ENTRY same|opposes      this community entry says what I hold / the opposite
    python -m focus unlink IDEA ENTRY
    python -m focus over A B                 "I hold A more firmly / find it more important than B"
    python -m focus engage|dismiss KEY       you looked at it / it is not important to you
    python -m focus snooze KEY [DAYS]        not now (default 14)
    python -m focus serve [--port 3130]      the same list as a page on 127.0.0.1 only

Reads your Episteme library read-only (EPISTEMIC_ROOT, default
~/workspace/epistemic; --branch dev for the dev build). Writes only its own
log under FOCUS_DIR (default ~/.local/share/arglog-focus). Private ideas
are shown on your terminal or on 127.0.0.1 and go nowhere else.
"""
import argparse
import datetime as dt
import sys

from . import library, score
from .state import FocusLog


def _key(k: str) -> str:
    return k if ":" in k else f"idea:{k}"


def current(args, log: FocusLog):
    from . import community as com
    st = log.state()
    comm = com.load_pulled(log.dir, st["pulls"][-1]) if st["pulls"] else None
    ideas = library.load(root=args.root, branch=args.branch)
    return ideas, st, comm


def render_text(items, comm) -> str:
    out = []
    if comm is None:
        out.append("(no community pulled yet: python -m focus pull URL --issuer AID)\n")
    elif not comm.verified:
        out.append("WARNING: the last community export did NOT fully verify: " + "; ".join(comm.problems[:3]) + "\n")
    for n, it in enumerate(items, 1):
        out.append(f"{n}. {it.title}")
        out.append(f"   {it.detail} · weight {it.weight} · score {it.score}")
        out += [f"     +{p:g}  {why}" for p, why in it.reasons]
        out += [f"     -> {label}: {target}" for label, target in it.moves]
        out.append("")
    return "\n".join(out) if items else "Nothing is pressing. Go learn something new.\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="focus", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", help="Episteme root (default $EPISTEMIC_ROOT or ~/workspace/epistemic)")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--dir", help="where focus keeps its own log (default $FOCUS_DIR or ~/.local/share/arglog-focus)")
    ap.add_argument("--budget", type=int, default=5)
    ap.add_argument("cmd", nargs="?", default="list")
    ap.add_argument("rest", nargs="*")
    ap.add_argument("--issuer")
    ap.add_argument("--port", type=int, default=3130)
    a = ap.parse_args(argv)
    log = FocusLog(a.dir)

    if a.cmd == "pull":
        from . import community as com
        if not a.rest or not a.issuer:
            ap.error("pull URL --issuer AID   (get the issuer identifier from somewhere other than that site)")
        comm, digest = com.pull(a.rest[0], a.issuer, log.dir)
        log.append("CommunityPulled", {"url": comm.url, "issuer": a.issuer, "digest": digest, "head_n": comm.head_n, "head": comm.head, "verified": comm.verified})
        print(f"{'verified' if comm.verified else 'NOT VERIFIED'}: {len(comm.entries)} entries up to #{comm.head_n}" + ("" if comm.verified else "\n  " + "\n  ".join(comm.problems)))
        return 0 if comm.verified else 1
    if a.cmd == "ideas":
        words = [w.lower() for w in a.rest]
        for i in library.load(root=a.root, branch=a.branch):
            if all(w in (i.id + " " + i.claim).lower() for w in words):
                print(f"{i.id}\t{i.stance}\t{i.claim[:110]}")
        return 0
    if a.cmd == "entries":
        _, _, comm = current(a, log)
        for e in (comm.entries if comm else []):
            print(f"{e.said}\t{e.display or 'rejected'}\t#{e.n} {e.kind} by {e.handle}: {e.text[:90]}")
        return 0
    if a.cmd in ("link", "unlink"):
        if len(a.rest) < 2 or (a.cmd == "link" and (len(a.rest) < 3 or a.rest[2] not in ("same", "opposes"))):
            ap.error("link IDEA ENTRY same|opposes   /   unlink IDEA ENTRY")
        ids = {i.id for i in library.load(root=a.root, branch=a.branch)}
        if a.rest[0] not in ids:
            ap.error(f"no idea '{a.rest[0]}' in your library (python -m focus ideas)")
        log.append("Linked" if a.cmd == "link" else "Unlinked", {"idea": a.rest[0], "entry": a.rest[1], **({"relation": a.rest[2]} if a.cmd == "link" else {})})
        return 0
    if a.cmd == "over":
        log.append("Compared", {"over": a.rest[0], "under": a.rest[1]})
        return 0
    if a.cmd in ("engage", "dismiss", "snooze"):
        st = log.state()
        data = {"item": _key(a.rest[0]), "response": {"engage": "engaged", "dismiss": "dismissed", "snooze": "snoozed"}[a.cmd],
                "head_n": st["pulls"][-1]["head_n"] if st["pulls"] else 0}
        if a.cmd == "snooze":
            data["until"] = (dt.date.today() + dt.timedelta(days=int(a.rest[1]) if len(a.rest) > 1 else 14)).isoformat()
        log.append("Responded", data)
        return 0
    if a.cmd == "serve":
        from .web import serve
        return serve(a, log)
    if a.cmd == "list":
        ideas, st, comm = current(a, log)
        print(render_text(score.focus(ideas, st, comm, budget=a.budget), comm))
        return 0
    ap.error(f"unknown command {a.cmd}")


if __name__ == "__main__":
    sys.exit(main())
