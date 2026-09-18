"""
What `focus` itself remembers: links between your ideas and community
entries, your "A over B" comparisons, and what you did with each item it
showed you. One append-only, hash-chained JSONL file; everything else is
rebuilt from it by replay (the pattern of the Episteme substrate and of the
community log). It lives OUTSIDE the Episteme library and outside this
repo: default ~/.local/share/arglog-focus/.
"""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path

EVENTS = {"Linked", "Unlinked", "Compared", "Responded", "CommunityPulled", "PipelineAdopted", "ListProduced"}
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
        self._load()

    def _load(self):
        """(Re)read the file. The page and the terminal are separate processes writing one log, so what is on disk,
        not what this process remembers, is the truth: state() and append() both come through here first."""
        self.events = []
        self._size = self.path.stat().st_size if self.path.exists() else 0
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
        with open(self.path, "a", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)              # one writer at a time; the chain link is read under the lock
            self._load()
            ev = self._append_locked(f, type_, data, at)
        self._size = self.path.stat().st_size
        return ev

    def _append_locked(self, f, type_, data, at):
        body = {"type": type_, "at": at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "data": data,
                "prev": self.events[-1]["hash"] if self.events else None}
        ev = dict(body, hash=hashlib.sha256(_canon(body)).hexdigest())
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        f.flush()
        self.events.append(ev)
        return ev

    # ---- replay ---------------------------------------------------------
    def state(self, upto: int | None = None) -> dict:
        """upto: replay only the first `upto` events (what focus knew at that point)."""
        if (self.path.stat().st_size if self.path.exists() else 0) != self._size:
            self._load()
        links: dict[tuple, dict] = {}        # (idea, entry) -> {relation, at}
        wins: dict[str, int] = {}
        losses: dict[str, int] = {}
        last: dict[str, dict] = {}           # item key -> last response {response, at, until, head_n}
        dismissed: dict[str, int] = {}
        pulls, pipelines, lists = [], [], []
        for index, ev in enumerate(self.events if upto is None else self.events[:upto]):
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
            elif t == "PipelineAdopted":
                pipelines.append(dict(d, at=ev["at"]))
            elif t == "ListProduced":
                lists.append(dict(d, at=ev["at"], index=index, hash=ev["hash"]))
        return {"links": links, "wins": wins, "losses": losses, "last": last, "dismissed": dismissed, "pulls": pulls,
                "pipelines": pipelines, "lists": lists}
