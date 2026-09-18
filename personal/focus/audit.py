"""
Zooming in, looking back, and trying changes.

    produce    compute the list and, when it differs from the last one
               recorded, write down exactly what it was computed from:
               the pipeline (by digest), how far the library had got
               (event sequence + hash), which community export (digest),
               the date, and the ranked result.
    recompute  rebuild any recorded list from those coordinates. The
               library is append-only, so "as of event N" is still there;
               exports are kept by digest; the focus log is replayed up to
               the list's own position. If a recomputed list differs from
               what was recorded, something upstream changed its past, and
               the audit says so.
    replay     run a CANDIDATE pipeline over every recorded list and
               compare it with what you actually did next: did it keep
               showing what you engaged with, and stop showing what you
               dismissed?
"""
import datetime as dt

from . import community as com, library, pipeline as pl, score


def _inputs(args, log, st, as_of=None, today=None, pull=None):
    snap = library.snapshot(root=args.root, branch=args.branch, db_path=getattr(args, "db_path", None), as_of=as_of, today=today)
    pull = pull if pull is not None else (st["pulls"][-1] if st["pulls"] else None)
    comm = com.load_pulled(log.dir, pull) if pull else None
    return snap, comm, pull


def produce(args, log, now=None, record=True):
    now = now or dt.datetime.now(dt.timezone.utc)
    st = log.state()
    p = pl.active(st)
    if getattr(args, "budget", None):          # a one-off look with another budget is not part of the record
        p, record = dict(p, budget=args.budget), False
    snap, comm, pull = _inputs(args, log, st, today=now.date())
    everything = score.evaluate(snap.ideas, st, comm, now, p)
    top = score.select(everything, p)
    coords = {"pipeline": pl.digest(p), "library_sequence": snap.head_sequence, "library_hash": snap.head_hash, "branch": args.branch,
              "community_digest": pull["digest"] if pull else None, "date": now.date().isoformat(), "now": now.isoformat(),
              "list": [[i.key, i.score] for i in top]}
    same = lambda a, b: all(a.get(k) == b.get(k) for k in ("pipeline", "library_hash", "community_digest", "date", "list"))
    if record and not (st["lists"] and same(st["lists"][-1], coords)):
        log.append("ListProduced", coords)
    return top, everything, snap, comm, p


def recompute(args, log, listed: dict, p: dict | None = None):
    """The list as it would have come out at that moment, under pipeline p (default: the one recorded)."""
    st = log.state(upto=listed["index"])
    if p is None:
        p = next((x["pipeline"] for x in reversed(st["pipelines"]) if pl.digest(x["pipeline"]) == listed["pipeline"]), None)
        if p is None:
            if pl.digest(pl.DEFAULT) != listed["pipeline"]:
                raise LookupError(f"pipeline {listed['pipeline'][:12]}… is not in the focus log and is not the built-in default")
            p = pl.DEFAULT
    pull = next((x for x in reversed(st["pulls"]) if x["digest"] == listed["community_digest"]), None)
    snap, comm, _ = _inputs(args, log, st, as_of=listed["library_sequence"], today=dt.date.fromisoformat(listed["date"]), pull=pull or False)
    now = dt.datetime.fromisoformat(listed["now"])
    return score.select(score.evaluate(snap.ideas, st, comm if pull else None, now, p), p)


def audit(args, log) -> list[dict]:
    out = []
    for listed in log.state()["lists"]:
        try:
            again = [[i.key, i.score] for i in recompute(args, log, listed)]
            out.append({"at": listed["at"], "pipeline": listed["pipeline"][:12], "library_sequence": listed["library_sequence"],
                        "reproduces": again == listed["list"], "recorded": listed["list"], "recomputed": again})
        except Exception as ex:
            out.append({"at": listed["at"], "pipeline": listed["pipeline"][:12], "library_sequence": listed["library_sequence"], "reproduces": False, "error": str(ex)})
    return out


def replay(args, log, candidate: dict) -> dict:
    """How the candidate would have done on your own history."""
    st = log.state()
    lists = st["lists"]
    rows, tally = [], {"engaged": [0, 0, 0], "dismissed": [0, 0, 0], "snoozed": [0, 0, 0]}   # [times, shown by recorded, shown by candidate]
    for n, listed in enumerate(lists):
        end = lists[n + 1]["index"] if n + 1 < len(lists) else len(log.events)
        responses = [(e["data"]["item"], e["data"]["response"]) for e in log.events[listed["index"]:end] if e["type"] == "Responded"]
        was = [k for k, _ in listed["list"]]
        new = [i.key for i in recompute(args, log, listed, candidate)]
        for item, response in responses:
            t = tally[response]
            t[0] += 1; t[1] += item in was; t[2] += item in new
        rows.append({"at": listed["at"], "was": was, "would_be": new, "entered": [k for k in new if k not in was], "left": [k for k in was if k not in new], "you_then": responses})
    return {"lists": rows, "tally": tally}


def diff_now(args, log, candidate: dict, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    st = log.state()
    snap, comm, _ = _inputs(args, log, st, today=now.date())
    out = {}
    for name, p in (("active", pl.active(st)), ("candidate", candidate)):
        ev = score.evaluate(snap.ideas, st, comm, now, p)
        out[name] = (score.select(ev, p), {i.key: i for i in ev})
    return out
