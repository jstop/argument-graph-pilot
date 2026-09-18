"""
The verifier against a log recorded from the live stack (real KERIA, real
witnesses, Signify clients as the phones; spike/11-record-log.ts). Nothing
is mocked and no signer is faked: every negative case is the recorded
material with bytes changed or removed, which is all an attacker without
the members' keys can do.

Not covered here, and why: an entry whose author cites SOMEONE ELSE'S
credential, and a credential from a registry the issuer does not control.
Both need an adversary who really signs, so they need their own recorded
fixtures; the end-to-end test in relying-party/test exercises the first
against the live stack.
"""
import copy
import json
import pathlib

import pytest
from keri.core import coring

from arglog_verifier.verify import verify_bundle

FIX = pathlib.Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def recorded():
    return load("recorded.json")


def resaid(sad):
    sad["d"] = coring.Saider.saidify(sad=dict(sad), label="d")[0].qb64


def failed(rep):
    return {e.n: e.failed for e in rep.entries}


def test_recorded_log_verifies_and_reproduces_strengths(recorded):
    rep = verify_bundle(recorded, trusted_issuer=recorded["log"][0]["payload"]["issuer"])
    assert rep.ok, (rep.log_checks, failed(rep))
    assert [e.handle for e in rep.entries] == ["alice", "bob", "rex"]
    by_n = {e.n: rep.strengths[e.said] for e in rep.entries}
    # claim attacked by one 1/2 and supported by one 1/2: va == vs, so it stays at the base score
    assert (by_n[1]["strength"], by_n[1]["display"]) == ("1/2", "0.5000")
    assert by_n[2]["strength"] == "1/2" and by_n[3]["strength"] == "1/2"


def test_revoked_members_earlier_entry_still_counts(recorded):
    rep = verify_bundle(recorded)
    rex = rep.entries[2]
    assert rex.ok and "revoked at issuer event" in dict((n, d) for n, _, d in rex.checks)["standing"]
    assert rep.strengths[rep.entries[0].said]["supporters"] == [rex.said]


def test_entry_signed_after_revocation_is_rejected_and_does_not_count():
    rep = verify_bundle(load("recorded-post-revocation.json"))
    assert not rep.ok
    assert failed(rep) == {1: None, 2: None, 3: None, 4: "standing"}
    late = rep.entries[3]
    assert [n for n, ok, _ in late.checks if ok] == ["record", "signature", "membership"]  # his key still works
    assert late.said not in rep.strengths
    assert rep.strengths[rep.entries[0].said]["strength"] == "1/2"   # same number as without it


def test_one_changed_byte_fails_the_record_check(recorded):
    b = copy.deepcopy(recorded)
    b["log"][1]["payload"]["text"] = b["log"][1]["payload"]["text"].replace("safe", "sage")   # one byte
    rep = verify_bundle(b)
    assert failed(rep)[1] == "record"
    # and what pointed at it has nothing valid to point at
    assert failed(rep)[2] == "target" and failed(rep)[3] == "target"


def test_rewritten_text_with_recomputed_digests_fails_the_signature_check(recorded):
    b = copy.deepcopy(recorded)
    b["log"][1]["payload"]["text"] = "Tap water here is poisonous."
    resaid(b["log"][1]["payload"])
    prev = None
    for rec in b["log"]:       # a careful forger re-chains the whole log
        if prev is not None:
            rec["p"] = prev
        if rec["n"] >= 1:
            resaid(rec)
        prev = rec["d"]
    rep = verify_bundle(b)
    assert failed(rep)[1] == "signature"
    assert "does not seal" in dict((n, d) for n, _, d in rep.entries[0].checks)["signature"]
    # re-chaining also changed the head the issuer sealed in its own log
    assert not dict((n, ok) for n, ok, _ in rep.log_checks)["log contains every head the issuer checkpointed"]


def test_event_with_too_few_witness_receipts_does_not_exist(recorded):
    b = copy.deepcopy(recorded)
    author = b["log"][2]["payload"]["author"]
    ev = b["kels"][author][1]
    atc = ev["atc"]
    i = atc.index("-BAG")                       # six witness signatures
    ev["atc"] = atc[4:i] + "-BAD" + atc[i + 4:i + 4 + 3 * 88]   # keep three; their threshold is four
    rep = verify_bundle(b)
    assert failed(rep)[2] == "signature"
    assert "witness receipts" in dict((n, d) for n, _, d in rep.entries[1].checks)["signature"]
    assert failed(rep)[1] is None and failed(rep)[3] is None


def test_truncated_log_is_detected_through_the_issuers_checkpoint(recorded):
    b = copy.deepcopy(recorded)
    b["log"] = b["log"][:3]      # drop rex's support, the head the issuer sealed
    rep = verify_bundle(b)
    assert not rep.ok
    assert not dict((n, ok) for n, ok, _ in rep.log_checks)["log contains every head the issuer checkpointed"]


def test_wrong_issuer_pin_fails_before_any_entry(recorded):
    rep = verify_bundle(recorded, trusted_issuer=recorded["log"][0]["payload"]["operator"])
    assert not rep.ok and rep.entries == []


def test_unpinned_issuer_is_reported_as_not_checked(recorded):
    assert any("community issuer" in n for n in verify_bundle(recorded).not_checked)


def test_truncated_credential_stream_returns_and_fails_closed(recorded):
    b = copy.deepcopy(recorded)
    cred = b["log"][1]["payload"]["credential"]
    b["credentials"][cred] = b["credentials"][cred][:-200]     # keripy's Parser.parse() would never return on this
    rep = verify_bundle(b)
    assert failed(rep)[1] == "membership"


def test_missing_credential_fails_closed(recorded):
    b = copy.deepcopy(recorded)
    del b["credentials"][b["log"][2]["payload"]["credential"]]
    assert failed(verify_bundle(b))[2] == "membership"


def test_payload_signed_for_another_log_is_rejected(recorded):
    b = copy.deepcopy(recorded)
    b["log"][1]["payload"]["log"] = b["log"][1]["d"]
    assert failed(verify_bundle(b))[1] == "record"


def test_export_that_withholds_the_revocation_event_cannot_hide_it():
    b = load("recorded-post-revocation.json")
    rex = b["log"][4]["payload"]["credential"]
    cesr = b["credentials"][rex]
    cut = cesr.index('{"v":"KERI10JSON', cesr.index('"t":"rev"') - 40)
    end = cesr.index('{"v":"ACDC')
    assert '"t":"rev"' in cesr[cut:end]
    b["credentials"][rex] = cesr[:cut] + cesr[end:]            # registry now says: issued
    rep = verify_bundle(b)
    assert failed(rep)[4] == "standing"
    assert "withholds" in dict((n, d) for n, _, d in rep.entries[3].checks)["standing"]
    assert failed(rep)[3] is None                               # his earlier entry is still inside the sealed head
