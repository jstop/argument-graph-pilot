"""
What `focus` itself remembers: links between your ideas and community
entries, your "A over B" comparisons, and what you did with each item it
showed you. One append-only, hash-chained JSONL file; everything else is
rebuilt from it by replay (the pattern of the Episteme substrate and of the
community log). It lives OUTSIDE the Episteme library and outside this
repo: default ~/.local/share/arglog-focus/.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

EVENTS = {"Linked", "Unlinked", "Compared", "Responded", "CommunityPulled"}
RESPONSES = {"engaged", "snoozed", "dismissed"}
RELATIONS = {"same", "opposes"}   # the community entry says what I hold / says the opposite


def default_dir() -> Path:
    return Path(os.environ.get("FOCUS_DIR") or Path.home() / ".local" / "share" / "arglog-focus")


def _canon(v) -> bytes:
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class FocusLog:
    def __init__(self, directory: Path | None = None):
        self.dir = Path(directory or default_dir())
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "focus.jsonl"
        self.events = []
        prev = None
        if self.path.exists():
            for n, line in enumerate(self.path.read_text(encoding="utf-8").splitlines()):
                if not line.strip():
                    continue
                ev = json.loads(line)
                body = {k: ev[k] for k in ("type", "at", "data", "prev")}
                if ev["prev"] != prev or ev["hash"] != hashlib.sha256(_canon(body)).hexdigest():
                    raise RuntimeError(f"{self.path} line {n + 1} does not chain; refusing to build on it")
                prev = ev["hash"]
                self.events.append(ev)

    def append(self, type_: str, data: dict, at: str | None = None) -> dict:
        if type_ not in EVENTS:
            raise ValueError(type_)
        body = {"type": type_, "at": at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "data": data,
                "prev": self.events[-1]["hash"] if self.events else None}
        ev = dict(body, hash=hashlib.sha256(_canon(body)).hexdigest())
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        self.events.append(ev)
        return ev

    # ---- replay ---------------------------------------------------------
    def state(self) -> dict:
        links: dict[tuple, dict] = {}        # (idea, entry) -> {relation, at}
        wins: dict[str, int] = {}
        losses: dict[str, int] = {}
        last: dict[str, dict] = {}           # item key -> last response {response, at, until, head_n}
        dismissed: dict[str, int] = {}
        pulls = []
        for ev in self.events:
            d, t = ev["data"], ev["type"]
            if t == "Linked":
                links[(d["idea"], d["entry"])] = {"relation": d["relation"], "at": ev["at"]}
            elif t == "Unlinked":
                links.pop((d["idea"], d["entry"]), None)
            elif t == "Compared":
                wins[d["over"]] = wins.get(d["over"], 0) + 1
                losses[d["under"]] = losses.get(d["under"], 0) + 1
            elif t == "Responded":
                last[d["item"]] = dict(d, at=ev["at"])
                if d["response"] == "dismissed":
                    dismissed[d["item"]] = dismissed.get(d["item"], 0) + 1
            elif t == "CommunityPulled":
                pulls.append(dict(d, at=ev["at"]))
        return {"links": links, "wins": wins, "losses": losses, "last": last, "dismissed": dismissed, "pulls": pulls}
