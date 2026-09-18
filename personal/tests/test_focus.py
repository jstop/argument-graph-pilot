"""
The personal layer against (a) a TEMPORARY Episteme library built with
Episteme's own substrate code (its rule: tests get temporary stores, never
the real one) and (b) the community log recorded from the live stack
(verifier/tests/fixtures/recorded.json), verified by the real verifier.
Nothing is mocked. Skipped, saying so, if Episteme is not on this machine.
"""
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(os.environ.get("EPISTEMIC_ROOT") or Path.home() / "workspace" / "epistemic")
if not (ROOT / "memory" / "substrate.py").exists():
    pytest.skip(f"SKIPPED: no Episteme checkout at {ROOT}; the personal layer was NOT exercised", allow_module_level=True)
sys.path.insert(0, str(ROOT / "memory"))

from focus import community as com, library, score          # noqa: E402
from focus.state import FocusLog                             # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "verifier" / "tests" / "fixtures" / "recorded.json"
NOW = dt.datetime(2026, 9, 18, 12, 0, tzinfo=dt.timezone.utc)


@pytest.fixture()
def lib(tmp_path):
    """water-safe <- (boil-advice, filter-choice); a lone SUSPECT idea; all owner-written."""
    import substrate
    log = substrate.CanonicalLog(tmp_path / "canonical.db", tmp_path / "evidence_store", actor=substrate.OWNER)
    ev = log.register_evidence(media_type="text/plain", content="Utility report: tap water meets the standard.", metadata={"author": "utility"})
    common = dict(method="asserted", volatility="historical", cluster="water", evidence_ids=[ev], observed_at="2026-09-01")
    log.form_belief(belief_id="water-safe", claim="Tap water here is safe to drink.", **common)
    for bid, claim in (("boil-advice", "Nobody here needs to boil water."), ("filter-choice", "A filter is a luxury, not a need.")):
        log.form_belief(belief_id=bid, claim=claim, method="derived", volatility="historical", cluster="water", premise_ids=["water-safe"], observed_at="2026-09-01")
    log.form_belief(belief_id="pipes-old", claim="The pipes on my street are lead.", method="asserted", volatility="historical", cluster="water", unsupported=True, observed_at="2026-09-01")
    log.close()
    return tmp_path / "canonical.db"


@pytest.fixture(scope="module")
def recorded():
    bundle = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return bundle, com.verify_export(bundle, bundle["log"][0]["payload"]["issuer"], url="https://log.example")


def ideas_of(db):
    return library.load(root=ROOT, db_path=db, today=NOW.date())


def test_library_is_read_read_only_and_uses_epistemes_own_stances(lib):
    before = hashlib.sha256(lib.read_bytes()).hexdigest()
    lib.chmod(0o444)
    ideas = {i.id: i for i in ideas_of(lib)}
    assert hashlib.sha256(lib.read_bytes()).hexdigest() == before
    assert ideas["water-safe"].dependents == 2 and ideas["boil-advice"].premises == ["water-safe"]
    assert ideas["water-safe"].stance == "RELY" and ideas["water-safe"].stood_behind
    assert ideas["pipes-old"].stance == "SUSPECT" and ideas["pipes-old"].unsupported


def test_every_item_states_its_reasons_and_the_score_is_weight_times_points(lib, tmp_path):
    items = score.focus(ideas_of(lib), FocusLog(tmp_path / "f").state(), None, now=NOW)
    assert [i.key for i in items] == ["idea:pipes-old"]           # the only idea with anything to do
    it = items[0]
    assert it.reasons and it.score == round(it.weight * sum(p for p, _ in it.reasons), 3)
    assert "nothing in your library supports it" in it.reasons[0][1]


def test_the_outside_world_gets_a_seat_until_you_link_or_dismiss_it(lib, tmp_path, recorded):
    _, comm = recorded
    assert comm.verified
    log = FocusLog(tmp_path / "f")
    claim = next(e for e in comm.entries if e.kind == "claim")
    items = score.focus(ideas_of(lib), log.state(), comm, now=NOW, budget=1 + 1)
    seat = next(i for i in items if i.key == f"entry:{claim.said}")
    assert "linked to nothing you hold" in seat.reasons[0][1]
    log.append("Responded", {"item": f"entry:{claim.said}", "response": "dismissed", "head_n": comm.head_n})
    assert not [i for i in score.focus(ideas_of(lib), log.state(), comm, now=NOW) if i.key.startswith("entry:")]


def test_an_attack_on_what_you_hold_becomes_pressure_weighted_by_what_rests_on_it(lib, tmp_path, recorded):
    _, comm = recorded
    log = FocusLog(tmp_path / "f")
    claim = next(e for e in comm.entries if e.kind == "claim")
    attack = next(e for e in comm.entries if e.kind == "attack")
    log.append("Linked", {"idea": "water-safe", "entry": claim.said, "relation": "same"})
    top = score.focus(ideas_of(lib), log.state(), comm, now=NOW)[0]
    assert top.key == "idea:water-safe"                          # heavy (2 rest on it) and under attack beats the lone SUSPECT
    assert any(p == 3.0 and "bob attacked it" in why and attack.text[:20] in why for p, why in top.reasons)
    assert (f"answer bob publicly (attack entry {attack.n}; your phone signs)", f"https://log.example/start?kind=attack&target={attack.said}") in top.moves
    # community strength is shown as pressure only when it diverges; here it stands at 1/2: no divergence line
    assert not any("stands at" in why for _, why in top.reasons)

    # you looked at it: the same attack is no longer news; a NEW attack would be
    log.append("Responded", {"item": "idea:water-safe", "response": "engaged", "head_n": comm.head_n}, at=NOW.isoformat())
    assert "idea:water-safe" not in [i.key for i in score.focus(ideas_of(lib), log.state(), comm, now=NOW)]


def test_an_outward_suggestion_only_where_the_topic_is_already_argued(lib, tmp_path, recorded):
    _, comm = recorded
    log = FocusLog(tmp_path / "f")
    assert not any("nobody has claimed it there" in why for i in score.focus(ideas_of(lib), log.state(), comm, now=NOW, budget=9) for _, why in i.reasons)
    log.append("Linked", {"idea": "boil-advice", "entry": next(e for e in comm.entries if e.kind == "claim").said, "relation": "same"})
    out = [i for i in score.focus(ideas_of(lib), log.state(), comm, now=NOW, budget=9) if any("nobody has claimed it there" in why for _, why in i.reasons)]
    assert [i.key for i in out] == ["idea:water-safe"]           # stood behind, confident, carries others, same cluster, unlinked
    assert any(target.startswith("https://log.example/start?kind=claim&text=Tap%20water") for _, target in out[0].moves)


def test_your_comparisons_and_dismissals_move_the_weight(lib, tmp_path):
    log = FocusLog(tmp_path / "f")
    ideas = {i.id: i for i in ideas_of(lib)}
    base = score.weight(ideas["pipes-old"], log.state())
    log.append("Compared", {"over": "pipes-old", "under": "water-safe"})
    assert score.weight(ideas["pipes-old"], log.state()) == base + 0.5
    log.append("Responded", {"item": "idea:pipes-old", "response": "dismissed", "head_n": 0})
    assert score.weight(ideas["pipes-old"], log.state()) == round((base + 0.5) / 2, 3)


def test_snoozed_items_stay_away_until_the_date(lib, tmp_path):
    log = FocusLog(tmp_path / "f")
    log.append("Responded", {"item": "idea:pipes-old", "response": "snoozed", "until": "2026-10-02", "head_n": 0})
    assert score.focus(ideas_of(lib), log.state(), None, now=NOW) == []
    assert score.focus(ideas_of(lib), log.state(), None, now=NOW + dt.timedelta(days=15)) != []


def test_a_tampered_export_exerts_no_pressure(lib, tmp_path, recorded):
    bundle, _ = recorded
    bad = json.loads(json.dumps(bundle))
    bad["log"][2]["payload"]["text"] = "The report found nothing at all."        # bob's attack, rewritten
    comm = com.verify_export(bad, bad["log"][0]["payload"]["issuer"], url="https://log.example")
    assert not comm.verified and comm.problems
    log = FocusLog(tmp_path / "f")
    log.append("Linked", {"idea": "water-safe", "entry": bad["log"][1]["d"], "relation": "same"})
    assert not any("attacked it" in why for i in score.focus(ideas_of(lib), log.state(), comm, now=NOW, budget=9) for _, why in i.reasons)


def test_focus_log_refuses_to_build_on_a_broken_chain(tmp_path):
    log = FocusLog(tmp_path / "f")
    log.append("Compared", {"over": "a", "under": "b"})
    log.append("Compared", {"over": "a", "under": "c"})
    p = tmp_path / "f" / "focus.jsonl"
    p.write_text(p.read_text(encoding="utf-8").replace('"under": "b"', '"under": "z"'), encoding="utf-8")
    with pytest.raises(RuntimeError, match="does not chain"):
        FocusLog(tmp_path / "f")
