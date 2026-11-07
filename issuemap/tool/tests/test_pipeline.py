"""Offline tests: a scripted fake model runs the whole pipeline end to end."""
import json

from issuemap import corpus, pipeline, render, verify
from issuemap.github import _next_link, parse_issue_url
from issuemap.llm import parse_json

THREAD = {
    "source": "https://github.com/o/r/issues/1",
    "title": "Pick a syntax",
    "comments": [
        {"id": "issue", "author": "alice", "created_at": "2024-01-01T00:00:00Z",
         "url": "u0", "body": "Should we use prefix or postfix?"},
        {"id": "11", "author": "bob", "created_at": "2024-01-02T00:00:00Z",
         "url": "u1", "body": "Postfix chains much better: `a.b().await.c()` reads left to right."},
        {"id": "12", "author": "carol", "created_at": "2024-01-03T00:00:00Z",
         "url": "u2", "body": "But **postfix** looks like a field access and will confuse beginners."},
        {"id": "13", "author": "dave", "created_at": "2024-01-04T00:00:00Z", "url": "u3",
         "body": "Here's a summary of the discussion so far: " + "x" * 1600},
    ],
}


class FakeModel:
    def json(self, system, user):
        if "careful scribe" in system:
            return {"claims": [
                {"comment_id": "11", "claim": "Postfix chains better.", "quote":
                 "Postfix chains much better", "kind": "argument", "about": ["postfix"]},
                {"comment_id": "12", "claim": "Postfix looks like a field.", "quote":
                 "postfix looks like a field access", "kind": "argument", "about": ["postfix"]},
                {"comment_id": "12", "claim": "Invented.", "quote": "words nobody wrote at all",
                 "kind": "argument", "about": []},
                {"comment_id": "999", "claim": "Bad id.", "quote": "x", "kind": "argument"},
            ]}
        if "merging duplicate" in system:
            return {"assign": [{"claim_id": "C1", "point_id": "P1"},
                               {"claim_id": "C2", "point_id": "P2"}],
                    "new_points": [{"point_id": "P1", "statement": "Postfix chains."},
                                   {"point_id": "P2", "statement": "Postfix resembles a field."}]}
        if "bear on each other" in system:
            return {"edges": [{"from": "P2", "to": "P1", "type": "attacks", "why": "cost"},
                              {"from": "P2", "to": "P9", "type": "attacks"}]}
        if "cruxes" in system:
            return {"cruxes": [{"question": "Does chaining outweigh familiarity?",
                                "sides": [{"answer": "Yes", "points": ["P1", "P404"]},
                                          {"answer": "No", "points": ["P2"]}],
                                "why_decisive": "w", "settles_by": "s"}]}
        raise AssertionError(system[:40])


def test_freeze_and_hash():
    c = corpus.freeze(THREAD, ["13"])
    assert c["frozen"]["comment_count"] == 3 and corpus.verify_frozen(c)
    c["comments"][0]["body"] = "tampered"
    assert not corpus.verify_frozen(c)


def test_suggest_exclusions():
    assert [s["id"] for s in corpus.suggest_exclusions(THREAD)] == ["13"]


def test_full_pipeline():
    c = corpus.freeze(THREAD, ["13"])
    m = pipeline.run(c, FakeModel(), log=lambda *_: None)
    assert len(m["claims"]) == 3                      # bad comment id dropped
    assert m["quote_check"] == {"verified": 2, "failed": 1, "failed_ids": ["C3"]}
    assert set(m["points"]) == {"P1", "P2", "P3"}     # unassigned claim kept, not lost
    assert m["edges"] == [{"from": "P2", "to": "P1", "type": "attacks", "why": "cost"}]
    assert m["cruxes"][0]["sides"][0]["points"] == ["P1"]
    page = render.render(m)
    assert "Does chaining outweigh familiarity?" in page and "quote not found" in page


def test_quote_normalisation():
    assert verify.normalise("**Post**fix  “X”") == 'postfix "x"'


def test_helpers():
    assert parse_issue_url("https://github.com/rust-lang/rust/issues/57640") == ("rust-lang", "rust", 57640)
    assert _next_link('<https://a?page=2>; rel="next", <https://a?page=9>; rel="last"') == "https://a?page=2"
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('Sure: [1, 2]') == [1, 2]
