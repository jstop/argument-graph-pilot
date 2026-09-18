"""
The community log as this layer sees it: only after the independent
verifier (verifier/arglog_verifier) has checked the export. What is kept
is the verifier's report joined with the entry texts, not the site's own
numbers. An entry the verifier rejected is kept, marked, and never counts
as pressure on anything.
"""
import contextlib
import hashlib
import io
import json
import sys
import urllib.request
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

VERIFIER_DIR = Path(__file__).resolve().parents[2] / "verifier"


@dataclass
class Entry:
    said: str
    n: int
    kind: str
    text: str
    handle: str
    author: str
    target: str | None
    ok: bool
    strength: Fraction | None
    display: str | None
    counted: bool | None
    checks: list = None          # the verifier's per-entry checks: [(name, ok, detail)]


@dataclass
class Community:
    url: str | None
    issuer: str
    head_n: int
    head: str
    verified: bool
    problems: list
    entries: list

    def by_said(self):
        return {e.said: e for e in self.entries}

    def responses_to(self, said: str, kind: str | None = None):
        return [e for e in self.entries if e.target == said and e.ok and (kind is None or e.kind == kind)]


def verify_export(bundle: dict, issuer: str, url: str | None = None) -> Community:
    if str(VERIFIER_DIR) not in sys.path:
        sys.path.insert(0, str(VERIFIER_DIR))
    from arglog_verifier.verify import verify_bundle   # keripy; slow import, and it prints
    with contextlib.redirect_stdout(io.StringIO()):
        rep = verify_bundle(bundle, trusted_issuer=issuer)
    payloads = {r.get("d"): r.get("payload") or {} for r in bundle.get("log", [])[1:] if isinstance(r, dict)}
    entries = []
    for e in rep.entries:
        p, s = payloads.get(e.said, {}), rep.strengths.get(e.said)
        entries.append(Entry(said=e.said, n=e.n, kind=e.kind, text=str(p.get("text", "")), handle=e.handle or "?", author=e.author or "?",
                             target=p.get("target"), ok=e.ok, strength=Fraction(s["strength"]) if s else None,
                             display=s["display"] if s else None, counted=s["counted"] if s else None, checks=list(e.checks)))
    log = bundle.get("log") or [{}]
    problems = [f"{name}: {detail}" for name, ok, detail in rep.log_checks if not ok] + \
               [f"entry {e.n} failed '{e.failed}'" for e in rep.entries if not e.ok]
    return Community(url=url, issuer=issuer, head_n=len(log) - 1, head=str(log[-1].get("d")), verified=rep.ok, problems=problems, entries=entries)


def pull(url: str, issuer: str, directory: Path) -> tuple[Community, str]:
    """Download <url>/export.json, verify it, keep the raw export beside the focus log (content-addressed)."""
    with urllib.request.urlopen(url.rstrip("/") + "/export.json", timeout=60) as r:
        raw = r.read()
    digest = hashlib.sha256(raw).hexdigest()
    (directory / "exports").mkdir(parents=True, exist_ok=True)
    (directory / "exports" / f"{digest}.json").write_bytes(raw)
    return verify_export(json.loads(raw.decode("utf-8")), issuer, url.rstrip("/")), digest


def load_pulled(directory: Path, pull_event: dict) -> Community:
    raw = (directory / "exports" / f"{pull_event['digest']}.json").read_bytes()
    return verify_export(json.loads(raw.decode("utf-8")), pull_event["issuer"], pull_event.get("url"))
