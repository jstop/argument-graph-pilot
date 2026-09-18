"""
Read-only view of a personal Episteme library (~/workspace/epistemic).

This NEVER writes to the library. Episteme's own CanonicalLog opens its
database read-write (it creates tables and directories on open), so we do
not call its constructor: we open SQLite ourselves with mode=ro and hand
that connection to Episteme's own code for the two things we need from it,
so we do not re-implement its rules:

    substrate.CanonicalLog.state   replay of the event log into beliefs
    engine._view / engine.stamped  the stance each belief wears (RELY, NOTE,
                                   SUSPECT, HYPOTHESIS, CONTESTED), including
                                   the dependency cap and the unreviewed cap

If Episteme changes those functions this adapter follows, which is the
point. Nothing about the owner's private beliefs leaves this process except
what `focus` prints or serves on 127.0.0.1.
"""
import datetime as dt
import os
import sqlite3
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

DEPENDS = ("DEPENDS_ON", "DERIVED_FROM")


@dataclass
class Idea:
    id: str
    claim: str
    stance: str
    method: str
    cluster: str | None
    freshness: str
    age_days: int | None
    contested: bool
    degraded_reason: str | None
    stood_behind: bool
    unsupported: bool = False
    premises: list = field(default_factory=list)      # ids this idea rests on
    dependents: int = 0                                # how many ideas rest on this one, transitively
    contradicted_by: list = field(default_factory=list)


def _episteme_modules(memory_dir: Path):
    if str(memory_dir) not in sys.path:
        sys.path.insert(0, str(memory_dir))
    import engine      # noqa: E402  (Episteme's own)
    import substrate   # noqa: E402
    return substrate, engine


def load(root: str | os.PathLike | None = None, branch: str = "main", db_path: str | os.PathLike | None = None,
         today: dt.date | None = None) -> list[Idea]:
    root = Path(root or os.environ.get("EPISTEMIC_ROOT") or Path.home() / "workspace" / "epistemic")
    substrate, engine = _episteme_modules(root / "memory")
    db = Path(db_path) if db_path else (root / "data" / "canonical.db" if branch == "main" else root / "data" / "builds" / branch / "canonical.db")
    if not db.exists():
        raise FileNotFoundError(f"no Episteme library at {db}")

    log = object.__new__(substrate.CanonicalLog)       # no __init__: that one writes
    log.actor = "reader:arglog-focus"
    log.db_path = db
    log._lock = threading.RLock()
    log.conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, check_same_thread=False)
    log.conn.row_factory = sqlite3.Row
    try:
        state = log.state()
    finally:
        log.conn.close()

    rels = state["relationships"]
    views = {bid: engine._view(bid, b, rels) for bid, b in state["beliefs"].items()}
    ref = today or dt.date.today()

    rests_on: dict[str, set] = {bid: set(state["beliefs"][bid].get("premise_ids") or []) for bid in views}
    contradicted: dict[str, list] = {bid: [] for bid in views}
    for r in rels:
        s, o, rel = r.get("subject_id"), r.get("object_id"), r.get("rel")
        if s in views and o in views:
            if rel in DEPENDS:
                rests_on[s].add(o)
            elif rel == "CONTRADICTS":
                contradicted[s].append(o)
                contradicted[o].append(s)

    carried_by: dict[str, set] = {bid: set() for bid in views}     # reverse edges
    for bid, premises in rests_on.items():
        for p in premises:
            if p in carried_by:
                carried_by[p].add(bid)

    def dependents(bid: str) -> int:
        seen, stack = set(), [bid]
        while stack:
            for d in carried_by.get(stack.pop(), ()):
                if d not in seen:
                    seen.add(d)
                    stack.append(d)
        seen.discard(bid)
        return len(seen)

    ideas = []
    for bid, v in views.items():
        if v["retired"]:
            continue
        v = dict(v, authorship=state["beliefs"][bid].get("authorship") or {})
        s = engine.stamped(v, ref=ref, by_id=views)
        ideas.append(Idea(
            id=bid, claim=s["claim"], stance=s["stance"], method=s["method"], cluster=s["cluster"],
            freshness=s["freshness"], age_days=s["age_days"], contested=s["contested"],
            degraded_reason=s["degraded_reason"],
            stood_behind=(s["authorship"].get("stood_behind_by") == substrate.OWNER),
            unsupported=bool(s["unsupported"] or s["verification_failed"]),
            premises=sorted(p for p in rests_on[bid] if p in views), dependents=dependents(bid),
            contradicted_by=sorted(set(contradicted[bid]))))
    return sorted(ideas, key=lambda i: i.id)
