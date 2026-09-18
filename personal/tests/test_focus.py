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


# ---- zooming in, looking back, trying changes ---------------------------------------------------

from types import SimpleNamespace                                  # noqa: E402

from focus import audit as au, pipeline as pl, trace               # noqa: E402


def setup(lib, tmp_path, recorded):
    """A focus log that has pulled the recorded community export, and args pointing at the temp library."""
    bundle, comm = recorded
    log = FocusLog(tmp_path / "f")
    raw = json.dumps(bundle).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    (log.dir / "exports").mkdir(parents=True, exist_ok=True)
    (log.dir / "exports" / f"{digest}.json").write_bytes(raw)
    log.append("CommunityPulled", {"url": "https://log.example", "issuer": bundle["log"][0]["payload"]["issuer"], "digest": digest, "head_n": comm.head_n, "head": comm.head, "verified": True})
    return log, SimpleNamespace(root=ROOT, branch="main", db_path=lib, budget=None), comm


def test_the_trace_shows_every_rule_with_its_inputs_including_the_ones_that_did_not_fire(lib, tmp_path, recorded):
    log, args, comm = setup(lib, tmp_path, recorded)
    claim = next(e for e in comm.entries if e.kind == "claim")
    log.append("Linked", {"idea": "water-safe", "entry": claim.said, "relation": "same"})
    top, everything, snap, c, p = au.produce(args, log, now=NOW)
    t = trace.build("idea:water-safe", everything, top, snap, c, log.state(), p, log)
    rules = {s["rule"]: s for s in t["signals"]}
    assert set(pl.DEFAULT["signals"]) - {"outside_base", "outside_per_response"} <= set(rules)      # every idea-rule is accounted for
    assert rules["community_attack"]["fired"] and rules["community_attack"]["inputs"]["you_last_looked_at_log_position"] == 0
    assert not rules["low_standing"]["fired"] and "not below 1/3" in rules["low_standing"]["text"]
    assert rules["low_standing"]["inputs"]["community_standing"] == "1/2"
    assert t["score"] == round(t["weight"] * sum(s["points"] for s in t["signals"] if s["fired"]), 3)
    assert [w for w, _ in t["weight_steps"]][1].endswith("log2(1 + 2 ideas that rest on it)")
    # down to the library: evidence, its author, who wrote the claim; and down to the verifier's checks on the entry
    assert t["library"]["evidence"][0]["author"] == "utility" and t["library"]["authorship"]["stood_behind_by"] == "owner"
    assert sorted(t["library"]["dependents"]) == ["boil-advice", "filter-choice"]
    assert [name for name, ok, _ in t["community"][0]["checks"] if ok] == ["record", "signature", "membership", "standing", "target"]
    out = trace.text(t)
    assert "RULES (every one, fired or not)" in out and "bob attacked it" in out and "threshold 4" in out


def test_a_pipeline_with_a_typo_is_refused_and_a_rule_set_to_zero_is_off(lib, tmp_path):
    bad = json.loads(json.dumps(pl.DEFAULT)); bad["signals"]["suspekt"] = 1
    with pytest.raises(ValueError, match="suspekt"):
        pl.validate(bad)
    off = json.loads(json.dumps(pl.DEFAULT)); off["signals"]["suspect"] = 0
    assert score.focus(ideas_of(lib), FocusLog(tmp_path / "f").state(), None, now=NOW, p=pl.validate(off)) == []


def test_lists_are_recorded_with_their_coordinates_and_still_reproduce_after_the_library_moves_on(lib, tmp_path, recorded):
    log, args, comm = setup(lib, tmp_path, recorded)
    au.produce(args, log, now=NOW)
    au.produce(args, log, now=NOW)                                  # same inputs, same list: not recorded twice
    lists = log.state()["lists"]
    assert len(lists) == 1 and lists[0]["pipeline"] == pl.digest(pl.DEFAULT) and lists[0]["library_hash"].startswith("sha256:")

    import substrate                                                # the library grows: a new heavy SUSPECT idea
    w = substrate.CanonicalLog(lib, lib.parent / "evidence_store", actor="agent:test-writer")
    w.form_belief(belief_id="new-worry", claim="The meter reads high.", method="asserted", volatility="historical", cluster="water", unsupported=True, observed_at="2026-09-10")
    w.close()
    au.produce(args, log, now=NOW)
    assert len(log.state()["lists"]) == 2 and log.state()["lists"][1]["list"] != lists[0]["list"]
    rows = au.audit(args, log)
    assert [r["reproduces"] for r in rows] == [True, True]          # the first list is rebuilt from the library AS OF its sequence


def test_replaying_a_candidate_pipeline_over_your_own_history(lib, tmp_path, recorded):
    log, args, comm = setup(lib, tmp_path, recorded)
    au.produce(args, log, now=NOW)                                  # shows pipes-old (SUSPECT) and the community claim
    log.append("Responded", {"item": "idea:pipes-old", "response": "dismissed", "head_n": comm.head_n})
    cand = json.loads(json.dumps(pl.DEFAULT)); cand["signals"]["suspect"] = 0; cand["signals"]["unreviewed"] = 0
    r = au.replay(args, log, pl.validate(cand))
    assert r["tally"]["dismissed"] == [1, 1, 0]                     # you dismissed it; the old rules showed it; the candidate would not have
    assert r["lists"][0]["left"] == ["idea:pipes-old"]
    # adopting is an event carrying the full text, so later lists name it and old ones still name the default
    log.append("PipelineAdopted", {"digest": pl.digest(cand), "pipeline": cand, "note": "stop nagging about suspects"})
    au.produce(args, log, now=NOW)
    assert [l["pipeline"] for l in log.state()["lists"]] == [pl.digest(pl.DEFAULT), pl.digest(cand)]
    assert all(row["reproduces"] for row in au.audit(args, log))


# ---- the page can do everything the terminal can ---------------------------------------------------

import re                                                          # noqa: E402
import threading                                                   # noqa: E402
import urllib.error                                                # noqa: E402
import urllib.parse                                                # noqa: E402
import urllib.request                                              # noqa: E402

from focus import web                                              # noqa: E402


@pytest.fixture()
def site(lib, tmp_path, recorded):
    log, args, comm = setup(lib, tmp_path, recorded)
    args.port = 0
    httpd, ui = web.make_server(args, log)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def get(path):
        return urllib.request.urlopen(base + path).read().decode("utf-8")

    def post(path, token=None, host=None, **fields):
        data = urllib.parse.urlencode({"token": ui.token if token is None else token, **fields}).encode()
        req = urllib.request.Request(base + path, data=data, headers={"Host": host} if host else {})
        try:
            r = urllib.request.urlopen(req)
            return r.status, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8")
    yield SimpleNamespace(get=get, post=post, log=log, comm=comm, ui=ui)
    httpd.shutdown()


def fresh(site):
    return FocusLog(site.log.dir).state()          # what is on disk, not what the server has in memory


def test_pages_render_and_every_form_carries_the_token(site):
    for path in ("/", "/ideas", "/ideas?q=water", "/community", "/pipeline", "/history", "/why?key=idea:water-safe"):
        page = site.get(path)
        assert "<nav>" in page
        assert len(re.findall(r'<form method="post"', page)) == page.count(f'name="token" value="{site.ui.token}"')
    assert "Tap water here is safe to drink." in site.get("/ideas?q=tap")


def test_a_post_without_the_token_or_to_another_hostname_changes_nothing(site):
    claim = next(e for e in site.comm.entries if e.kind == "claim")
    before = len(fresh(site)["links"])
    assert site.post("/link", token="guess", idea="water-safe", entry=claim.said, relation="same")[0] == 403
    assert site.post("/link", host="evil.example:80", idea="water-safe", entry=claim.said, relation="same")[0] == 403
    assert len(fresh(site)["links"]) == before


def test_link_compare_respond_and_unlink_from_the_page(site):
    claim = next(e for e in site.comm.entries if e.kind == "claim")
    assert site.post("/link", idea="no-such-idea", entry=claim.said, relation="same")[0] == 400
    assert site.post("/link", idea="water-safe", entry=claim.said, relation="same", back="/community")[0] == 200     # 303 followed
    assert ("water-safe", claim.said) in fresh(site)["links"]
    assert "bob attacked it" in site.get("/")                       # the attack is now pressure on my idea, on the page
    why = site.get("/why?key=idea:water-safe")
    assert "Unlink" in why and "Every rule, fired or not" in why
    site.post("/over", over="pipes-old", under="water-safe")
    assert fresh(site)["wins"] == {"pipes-old": 1}
    site.post("/respond", item="idea:water-safe", response="snoozed", days="60")
    assert fresh(site)["last"]["idea:water-safe"]["until"] == (dt.date.today() + dt.timedelta(days=60)).isoformat()
    site.post("/unlink", idea="water-safe", entry=claim.said)
    assert fresh(site)["links"] == {}


def test_edit_try_replay_and_adopt_a_pipeline_from_the_page(site):
    site.get("/")                                                   # a list gets recorded: pipes-old is shown
    site.post("/respond", item="idea:pipes-old", response="dismissed")
    form = {f"{sec}.{k}": v for sec in ("signals", "weight", "thresholds") for k, v in pl.DEFAULT[sec].items()}
    form.update({"budget": 5, "outside_seat": "on", "signals.suspect": 0, "signals.unreviewed": 0})
    status, page = site.post("/pipeline", do="try", **form)
    assert status == 200 and "OUT" in page and "suspect: 1.5 → 0" in page
    assert fresh(site)["pipelines"] == []                           # trying adopts nothing
    status, page = site.post("/pipeline", do="replay", **form)
    assert "<td>dismissed</td><td>1</td><td>1</td><td>0</td>" in page
    status, page = site.post("/pipeline", do="adopt", note="stop nagging", **form)
    adopted = fresh(site)["pipelines"]
    assert status == 200 and len(adopted) == 1 and adopted[0]["pipeline"]["signals"]["suspect"] == 0 and adopted[0]["note"] == "stop nagging"
    assert site.post("/pipeline", do="try", **dict(form, **{"thresholds.low": "9/10", "thresholds.high": "1/10"}))[0] == 400   # refused, not guessed
    assert "reproduces" in site.get("/history")


def test_the_page_and_the_terminal_can_both_write_the_same_log_without_breaking_its_chain(tmp_path):
    page, terminal = FocusLog(tmp_path / "f"), FocusLog(tmp_path / "f")     # two processes' views of one file
    page.append("Compared", {"over": "a", "under": "b"})
    terminal.append("Compared", {"over": "c", "under": "d"})               # did not know about the page's write
    page.append("Compared", {"over": "e", "under": "f"})
    assert page.state()["wins"] == {"a": 1, "c": 1, "e": 1} == terminal.state()["wins"]
    assert len(FocusLog(tmp_path / "f").events) == 3                        # and it still chains when read from scratch
