"""
Replaying KERI material with keripy, as a third party.

Started from ../demo/osmio_demo/verification.py and keeps its three fixes:

  1. keripy's Parser.parse() never returns on a truncated stream, so we drive
     the parser generator ourselves and stop when it stalls (bounded_parse).
  2. keripy's credential Verifier keeps ("saves") credentials that have been
     revoked, so `reger.saved` is never read as "valid". Status is read from
     the replayed registry every time.
  3. keripy does not check that the registry a credential names belongs to the
     issuer it names, so we compare the registry's controller to the issuer
     and re-derive the issuance anchor from the issuer's own key event log.

Everything is held in temporary databases that vanish with the process.
Kevery(lax=False, local=False) is what makes keripy hold an event in escrow
until it carries at least the threshold of witness receipts its controller
declared; an event that never leaves escrow does not exist for us.
"""
import json

from keri.app import habbing
from keri.core import eventing, parsing, serdering
from keri.db import dbing
from keri.vdr import eventing as teventing
from keri.vdr import verifying, viring


def bounded_parse(stream: bytes, **handlers):
    """Parse a complete CESR stream, then stop (fix 1)."""
    ims = bytearray(stream)
    gen = parsing.Parser(framed=True).allParsator(ims=ims, framed=True, **handlers)
    remaining, stalls = len(ims), 0
    while stalls < 3:
        try:
            next(gen)
        except StopIteration:
            break
        except Exception:
            break  # malformed input: keep what verified so far; the checks decide
        stalls = stalls + 1 if len(ims) == remaining else 0
        remaining = len(ims)
    gen.close()


def event_bytes(ked: dict, atc: str) -> bytes:
    """A key event as exported by a KERIA agent ({ked, atc}) back to its wire form.
    The serialization is checked by keripy against the event's own digest, so a
    re-serialization that differs from what was signed is rejected, not trusted."""
    return json.dumps(ked, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + atc.encode("ascii")


class Replay:
    def __init__(self, name="arglog-verifier"):
        self.hby = habbing.Habery(name=name, temp=True)
        self.reger = viring.Reger(name=name, temp=True)
        self.kvy = eventing.Kevery(db=self.hby.db, lax=False, local=False)
        self.tvy = teventing.Tevery(db=self.hby.db, reger=self.reger, local=False)
        self.vry = verifying.Verifier(hby=self.hby, reger=self.reger)
        self.vry.tvy = self.tvy

    def close(self):
        self.reger.close(clear=True)
        self.hby.close(clear=True)

    def ingest(self, stream: bytes):
        if not stream:
            return
        bounded_parse(stream, kvy=self.kvy, tvy=self.tvy, vry=self.vry)
        for _ in range(3):  # out-of-order arrivals wait in escrow for what they depend on
            self.kvy.processEscrows()
            self.tvy.processEscrows()
            self.vry.processEscrows()

    # -- key event logs ---------------------------------------------------

    def kever(self, aid):
        return self.kvy.kevers.get(aid)

    def accepted_events(self, aid):
        """Every event keripy ACCEPTED for aid, in order: [(serder, n_controller_sigs, n_witness_receipts)]."""
        out = []
        if aid not in self.kvy.kevers:
            return out
        for msg in self.hby.db.clonePreIter(pre=aid):
            serder = serdering.SerderKERI(raw=bytes(msg))
            key = dbing.dgKey(aid, serder.said)
            out.append((serder, len(self.hby.db.getSigs(key)), len(self.hby.db.getWigs(key))))
        return out

    def accepted_event(self, aid, sn: int):
        for serder, nsigs, nwigs in self.accepted_events(aid):
            if serder.sn == sn:
                return serder, nsigs, nwigs
        return None

    # -- registries ---------------------------------------------------------

    def registry(self, regk):
        return self.reger.tevers.get(regk)

    def issuance_anchored(self, issuer, said, state_anchor_of_iss) -> bool:
        """Fix 3, second half: the issuance event's digest must be sealed in the ISSUER's own log."""
        iss_dig = self.reger.getTel(dbing.snKey(said, 0))
        if iss_dig is None:
            return False
        seal = dict(i=said, s="0", d=bytes(iss_dig).decode())
        for serder, _, _ in self.accepted_events(issuer):
            if seal in (serder.seals or []):
                return True
        return False
