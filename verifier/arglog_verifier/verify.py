"""
Verify an exported argument log from nothing but the export.

Input: one JSON bundle (format "arglog-export/1"):
    log          the entries, genesis first
    kels         {AID: [{ked, atc}, ...]}  key event logs of the operator, the issuer, every author
    credentials  {credential SAID: CESR text}  the ACDC with the issuer's log, the registry
                 and the credential's issue/revoke events, as the ISSUER's agent exports it

Every entry goes through the same checks in the same order and stops at the
first failure (fail closed). A check that could not be carried out fails.

    0 record      the record and its payload hash to their own identifiers; the
                  record links to the previous one; the payload names this log
    1 signature   the author's replayed key event log holds, at the stated
                  sequence number, an interaction event with that digest that
                  seals the payload digest; keripy accepted it, which requires
                  the keys current at that point and the declared threshold of
                  witness receipts
    2 membership  the credential hashes to its identifier, uses the schema and
                  issuer the genesis entry declares, names the author as its
                  subject; its registry was created by that issuer; its
                  issuance is sealed in the issuer's own log
    3 standing    the credential was not revoked before this entry (see
                  DESIGN.md, "What establishes afterward")
    4 target      support/attack names an EARLIER entry that itself passed

Only entries that pass every check are arguments. Strengths are then
recomputed by this package's own DF-QuAD implementation.
"""
from dataclasses import dataclass, field

from keri.core import coring, serdering

from . import dfquad
from .replay import Replay, event_bytes

FORMAT = "arglog-export/1"
RECORD_VERSION = "arglog/1"
CHECKS = ["record", "signature", "membership", "standing", "target"]
KINDS = ("claim", "support", "attack")


@dataclass
class EntryResult:
    n: int
    said: str
    kind: str = "?"
    author: str | None = None
    handle: str | None = None
    ok: bool = False
    failed: str | None = None          # name of the first failed check
    checks: list = field(default_factory=list)   # [(name, ok, detail)]

    def add(self, name, ok, detail):
        self.checks.append((name, bool(ok), detail))
        if not ok and self.failed is None:
            self.failed = name
        return bool(ok)


@dataclass
class Report:
    log_checks: list = field(default_factory=list)   # [(name, ok, detail)]
    entries: list = field(default_factory=list)
    strengths: dict = field(default_factory=dict)
    genesis: dict | None = None
    not_checked: list = field(default_factory=list)

    @property
    def ok(self):
        return all(ok for _, ok, _ in self.log_checks) and all(e.ok for e in self.entries) and bool(self.entries)


def said_ok(sad: dict) -> bool:
    try:
        return isinstance(sad.get("d"), str) and coring.Saider(qb64=sad["d"]).verify(dict(sad), prefixed=True, label="d")
    except Exception:
        return False


def find_acdc(stream: bytes):
    """The single ACDC in a credential export; raises ValueError otherwise."""
    found, idx = [], 0
    while True:
        idx = stream.find(b'{"v":"ACDC', idx)
        if idx < 0:
            break
        try:
            creder = serdering.SerderACDC(raw=stream[idx:])  # raises unless content hashes to its SAID
        except Exception as ex:
            raise ValueError(f"credential does not hash to its own identifier ({type(ex).__name__})")
        found.append(creder)
        idx += creder.size
    if len(found) != 1:
        raise ValueError(f"expected exactly one credential, found {len(found)}")
    return found[0]


def verify_bundle(bundle: dict, trusted_issuer: str | None = None) -> Report:
    rep = Report()
    log_add = lambda name, ok, detail: (rep.log_checks.append((name, bool(ok), detail)), bool(ok))[1]

    if not log_add("export format", bundle.get("format") == FORMAT and isinstance(bundle.get("log"), list) and bundle["log"],
                   f"format {bundle.get('format')!r}"):
        return rep
    log = bundle["log"]

    rp = Replay()
    try:
        # Untrusted input, all of it. keripy keeps only what verifies.
        for aid, events in (bundle.get("kels") or {}).items():
            rp.ingest(b"".join(event_bytes(e["ked"], e["atc"]) for e in events))
        creds = {}
        for said, cesr in (bundle.get("credentials") or {}).items():
            raw = cesr.encode("utf-8")
            rp.ingest(raw)
            creds[said] = raw
        _verify(rep, log_add, log, creds, rp, trusted_issuer)
    finally:
        rp.close()
    return rep


def _anchored(rp, aid, anchor, payload_said):
    """(ok, detail) for: aid's accepted log holds event anchor.d at anchor.s, an ixn sealing payload_said."""
    try:
        sn = int(anchor["s"], 16)
    except Exception:
        return False, "anchor has no usable sequence number"
    kever = rp.kever(aid)
    if kever is None:
        return False, f"no verifiable key event log for {aid}"
    hit = rp.accepted_event(aid, sn)
    if hit is None:
        return False, (f"{aid} has no accepted event #{sn}; its verified log ends at #{kever.sn} "
                       f"(an event short of {kever.toader.num} witness receipts stays unaccepted)")
    serder, nsigs, nwigs = hit
    if serder.said != anchor.get("d"):
        return False, f"event #{sn} in the verified log is {serder.said}, the entry cites {anchor.get('d')}"
    if anchor.get("ked") is not None and anchor["ked"].get("d") != serder.said:
        return False, "the event copied into the entry is not the event in the verified log"
    if serder.ilk != coring.Ilks.ixn:
        return False, f"event #{sn} is {serder.ilk}, not an interaction event"
    if {"d": payload_said} not in (serder.seals or []):
        return False, f"event #{sn} does not seal {payload_said}"
    return True, (f"event #{sn} of {aid[:12]}… seals the payload; {nsigs} controller signature(s), "
                  f"{nwigs} witness receipt(s), threshold {kever.toader.num}")


def _verify(rep, log_add, log, creds, rp, trusted_issuer):
    # ---- genesis ---------------------------------------------------------
    g = log[0]
    gp = g.get("payload") or {}
    ok = (g.get("format") == RECORD_VERSION and g.get("n") == 0 and g.get("p") is None and said_ok(g) and said_ok(gp)
          and gp.get("kind") == "genesis")
    if not log_add("genesis record", ok, f"genesis {g.get('d')}"):
        return
    rep.genesis = gp
    issuer, schema, operator = gp.get("issuer"), gp.get("schema"), gp.get("operator")
    ok, detail = _anchored(rp, operator, g.get("anchor") or {}, gp["d"])
    if not log_add("genesis signed by the log operator", ok, detail):
        return
    try:
        dfquad.check_params(gp.get("semantics"))
        log_add("semantics parameters", True, f"declared in genesis: {gp['semantics']}")
    except Exception as ex:
        log_add("semantics parameters", False, f"this verifier does not implement them: {ex}")
        return
    if trusted_issuer is not None:
        if not log_add("community issuer", issuer == trusted_issuer,
                       f"genesis declares {issuer}; you were told {trusted_issuer}"):
            return
    else:
        rep.not_checked.append(f"community issuer: taken from the genesis entry ({issuer}); pass --issuer to pin the "
                               f"one you were given out of band")
    ikever = rp.kever(issuer)
    if not log_add("issuer key event log", ikever is not None,
                   "no verifiable log for the issuer" if ikever is None else
                   f"verified events #0..#{ikever.sn}, threshold {ikever.toader.num} of {len(ikever.wits)} witnesses"):
        return

    # ---- issuer checkpoints: digest-only seals in the issuer's log ----------
    index_of = {e.get("d"): i for i, e in enumerate(log)}
    checkpoints = []   # (issuer sn, log index)
    missing = []
    for serder, _, _ in rp.accepted_events(issuer):
        for seal in serder.seals or []:
            if list(seal.keys()) == ["d"]:
                if seal["d"] in index_of:
                    checkpoints.append((serder.sn, index_of[seal["d"]]))
                else:
                    missing.append((serder.sn, seal["d"]))
    log_add("log contains every head the issuer checkpointed", not missing,
            f"{len(checkpoints)} checkpoint(s) found in the issuer's log, all present in this log" if not missing else
            "; ".join(f"issuer event #{sn} sealed log head {d}, which this log does not contain (truncated or forked)"
                      for sn, d in missing))

    # ---- entries ------------------------------------------------------------
    valid = {}       # said -> entry (passed everything)
    graph = []
    prev = g["d"]
    for n, e in enumerate(log[1:], start=1):
        p = e.get("payload") or {}
        r = EntryResult(n=n, said=str(e.get("d")), kind=str(p.get("kind")), author=p.get("author"))
        rep.entries.append(r)

        # 0 record
        problems = []
        if e.get("format") != RECORD_VERSION: problems.append("unknown record version")
        if not said_ok(e): problems.append("record does not hash to its identifier")
        if not said_ok(p): problems.append("payload does not hash to its identifier")
        if e.get("n") != n: problems.append(f"position says {e.get('n')}, is {n}")
        if e.get("p") != prev: problems.append("does not link to the previous record")
        if p.get("log") != g["d"]: problems.append("payload was signed for a different log")
        if p.get("kind") not in KINDS: problems.append(f"kind {p.get('kind')!r}")
        if not isinstance(p.get("text"), str) or not p.get("text"): problems.append("no text")
        if (p.get("kind") == "claim") != ("target" not in p): problems.append("claim with a target, or edge without one")
        prev = e.get("d")   # the chain continues from what is there, so one bad record fails once, not forever
        if not r.add("record", not problems, "; ".join(problems) or f"record and payload hash correctly; follows #{n - 1}"):
            continue

        # 1 signature
        ok, detail = _anchored(rp, p["author"], e.get("anchor") or {}, p["d"])
        if not r.add("signature", ok, detail):
            continue

        # 2 membership
        cred_said = p.get("credential")
        try:
            if cred_said not in creds:
                raise ValueError("the export does not contain this credential")
            creder = find_acdc(creds[cred_said])
            if creder.said != cred_said: raise ValueError(f"export holds {creder.said} under this name")
            if creder.schema != schema: raise ValueError(f"schema {creder.schema}, genesis declares {schema}")
            if creder.issuer != issuer: raise ValueError(f"issued by {creder.issuer}, not the community issuer")
            if creder.attrib.get("i") != p["author"]: raise ValueError(f"issued to {creder.attrib.get('i')}, not to the author")
            tever = rp.registry(creder.regi)
            if tever is None: raise ValueError(f"no verifiable registry {creder.regi}")
            if tever.pre != issuer: raise ValueError(f"registry {creder.regi} was created by {tever.pre}, not by the issuer")
            state = tever.vcState(cred_said)
            if state is None: raise ValueError("the issuer's registry has no issuance event for it")
            if not rp.issuance_anchored(issuer, cred_said, state): raise ValueError("issuance is not sealed in the issuer's own log")
            r.handle = creder.attrib.get("handle")
            r.add("membership", True, f"credential {cred_said[:12]}… for '{r.handle}', registry {creder.regi[:12]}… of the issuer")
        except ValueError as ex:
            r.add("membership", False, str(ex))
            continue

        # 3 standing
        if state.et in (coring.Ilks.iss, coring.Ilks.bis):
            r.add("standing", True, "issued, not revoked as of the exported registry")
        else:
            rev_sn = int(state.a["s"])
            covered = max((idx for sn, idx in checkpoints if sn < rev_sn), default=-1)
            r.add("standing", n <= covered,
                  f"revoked at issuer event #{rev_sn}; " +
                  (f"this entry (#{n}) is inside the log head #{covered} the issuer sealed before revoking" if n <= covered else
                   f"the last log head the issuer sealed before that is #{covered}, this entry is #{n}: "
                   f"signed after revocation, or not provably before it"))
            if not r.ok and r.failed:
                continue

        # 4 target
        if p["kind"] != "claim":
            t = p.get("target")
            if not r.add("target", t in valid and index_of.get(t, n) < n,
                         f"targets #{index_of[t]}" if t in valid else f"target {t} is not an earlier valid entry"):
                continue
        else:
            r.add("target", True, "a claim has none")

        r.ok = True
        valid[e["d"]] = e
        graph.append({"id": e["d"], "kind": p["kind"], "author": p["author"], **({"target": p["target"]} if "target" in p else {})})

    rep.strengths = {row["id"]: row for row in dfquad.evaluate(graph, gp["semantics"])}
