import copy
import itertools
import json
import random
from fractions import Fraction
from pathlib import Path

import pytest

from arglog_verifier.dfquad import DfQuadError, aggregate, display, evaluate, exact

SUITE = json.loads(
    (Path(__file__).resolve().parents[2] / "semantics" / "vectors.json").read_text(encoding="utf-8")
)
PARAMS = SUITE["params"]


@pytest.mark.parametrize("vector", SUITE["vectors"], ids=lambda v: v["name"])
def test_vector(vector):
    results = evaluate(vector["entries"], PARAMS)
    assert [r["id"] for r in results] == [e["id"] for e in vector["entries"]]
    assert set(vector["expect"]) == {r["id"] for r in results}
    for r in results:
        want = vector["expect"][r["id"]]
        assert r["strength"] == want["strength"], r["id"]
        assert r["display"] == want["display"], r["id"]
        assert r["counted"] is want["counted"], r["id"]


@pytest.mark.parametrize("case", SUITE["errors"], ids=lambda c: c["name"])
def test_error_vector(case):
    with pytest.raises(DfQuadError) as caught:
        evaluate(case["entries"], case.get("params", PARAMS))
    assert caught.value.code == case["error"]


def test_attackers_and_supporters_list_only_counted_in_log_order():
    vector = next(v for v in SUITE["vectors"] if v["name"] == "mixed-graph")
    by_id = {r["id"]: r for r in evaluate(vector["entries"], PARAMS)}
    assert by_id["e1"]["attackers"] == ["e3"]
    assert by_id["e1"]["supporters"] == ["e4"]
    assert by_id["e6"]["attackers"] == ["e8"]
    assert by_id["e10"]["attackers"] == []


def test_aggregate_is_order_independent():
    values = [Fraction(1, 2), Fraction(1, 4), Fraction(3, 8), Fraction(11, 32), Fraction(1, 16)]
    # 1 - (1/2)(3/4)(5/8)(21/32)(15/16) = 1 - 4725/32768
    assert exact(aggregate(values)) == "28043/32768"
    assert exact(aggregate([])) == "0/1"
    for perm in itertools.permutations(values):
        assert exact(aggregate(perm)) == "28043/32768"


def test_log_order_of_attackers_does_not_change_the_target():
    # Four attackers of c with distinct strengths 1/2, 1/4, 3/8, 3/4.
    attackers = [
        {"id": "p", "kind": "attack", "author": "u1", "target": "c"},
        {"id": "q", "kind": "attack", "author": "u2", "target": "c"},
        {"id": "r", "kind": "attack", "author": "u3", "target": "c"},
        {"id": "s", "kind": "attack", "author": "u4", "target": "c"},
    ]
    tail = [
        {"id": "q1", "kind": "attack", "author": "v", "target": "q"},
        {"id": "r1", "kind": "attack", "author": "v", "target": "r"},
        {"id": "r2", "kind": "attack", "author": "w", "target": "r1"},
        {"id": "s1", "kind": "support", "author": "v", "target": "s"},
    ]
    head = [{"id": "c", "kind": "claim", "author": "alice"}]
    # F = 1 - (1/2)(3/4)(5/8)(1/4) = 1 - 15/256 = 241/256; c = 1/2 - 241/512 = 15/512
    rng = random.Random(20260918)
    for _ in range(24):
        middle = copy.deepcopy(attackers)
        rng.shuffle(middle)
        by_id = {r["id"]: r for r in evaluate(head + middle + tail, PARAMS)}
        assert by_id["c"]["strength"] == "15/512"
        assert by_id["c"]["display"] == "0.0293"
        assert by_id["c"]["attackers"] == [e["id"] for e in middle]


def test_display_is_half_even_without_floats():
    assert display(Fraction(1, 32)) == "0.0312"
    assert display(Fraction(3, 32)) == "0.0938"
    assert display(Fraction(11, 32)) == "0.3438"
    assert display(Fraction(21, 64)) == "0.3281"
    assert display(Fraction(3, 64)) == "0.0469"
    assert display(Fraction(0)) == "0.0000"
    assert display(Fraction(1)) == "1.0000"
    assert display(Fraction(1, 3)) == "0.3333"
    assert display(Fraction(2, 3)) == "0.6667"
    # 2**-60 below / above a tie: a float would lose this
    assert display(Fraction(1, 32) + Fraction(1, 2**60)) == "0.0313"
    assert display(Fraction(3, 32) - Fraction(1, 2**60)) == "0.0937"
    assert display(Fraction(99999, 100000) + Fraction(1, 200000)) == "1.0000"


def test_integers_serialize_with_denominator_one():
    assert exact(Fraction(0)) == "0/1"
    assert exact(Fraction(1)) == "1/1"
    p = dict(PARAMS, base_score="1/1")
    log = [
        {"id": "c", "kind": "claim", "author": "a"},
        {"id": "x", "kind": "attack", "author": "b", "target": "c"},
    ]
    got = {r["id"]: r for r in evaluate(log, p)}
    assert (got["c"]["strength"], got["c"]["display"]) == ("0/1", "0.0000")
    assert (got["x"]["strength"], got["x"]["display"]) == ("1/1", "1.0000")


def test_other_base_score_by_hand():
    # tau = 1/3: attacker = 1/3; attacked = 1/3 - 1/3*1/3 = 2/9; supported = 1/3 + 2/3*1/3 = 5/9
    p = dict(PARAMS, base_score="1/3")
    got = evaluate(
        [
            {"id": "c", "kind": "claim", "author": "a"},
            {"id": "d", "kind": "claim", "author": "a"},
            {"id": "x", "kind": "attack", "author": "b", "target": "c"},
            {"id": "y", "kind": "support", "author": "b", "target": "d"},
        ],
        p,
    )
    assert [(r["strength"], r["display"]) for r in got] == [
        ("2/9", "0.2222"),
        ("5/9", "0.5556"),
        ("1/3", "0.3333"),
        ("1/3", "0.3333"),
    ]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(semantics="quad"),
        lambda p: p.update(influence="euler"),
        lambda p: p.update(duplicates="all"),
        lambda p: p.update(base_score="2/4"),
        lambda p: p.update(base_score="3/2"),
        lambda p: p.update(base_score=0.5),
        lambda p: p.update(base_score="0.5"),
        lambda p: p["display"].update(decimals=6),
        lambda p: p["display"].update(decimals=True),
        lambda p: p.pop("duplicates"),
        lambda p: p.update(cap=64),
    ],
)
def test_params_are_refused_not_defaulted(mutate):
    p = copy.deepcopy(PARAMS)
    mutate(p)
    with pytest.raises(DfQuadError) as caught:
        evaluate([{"id": "c", "kind": "claim", "author": "a"}], p)
    assert caught.value.code == "unsupported-parameter"


def _chain(n):
    log = [{"id": "e0", "kind": "claim", "author": "a"}]
    for i in range(1, n):
        log.append({"id": f"e{i}", "kind": "attack", "author": "ab"[i % 2], "target": f"e{i - 1}"})
    return log


def _tree(width, depth):
    log = [{"id": "n", "kind": "claim", "author": "root"}]
    level = ["n"]
    for _ in range(depth):
        nxt = []
        for parent in level:
            for k in range(width):
                child = f"{parent}.{k}"
                log.append({"id": child, "kind": "attack", "author": f"u{k}", "target": parent})
                nxt.append(child)
        level = nxt
    return log


def _max_den_bits(results):
    return max(int(r["strength"].split("/")[1]).bit_length() for r in results)


def test_measured_denominator_growth():
    # Numbers quoted in SEMANTICS.md. Measured, not derived from a cap.
    assert _max_den_bits(evaluate(_chain(200), PARAMS)) == 201
    tree = _tree(3, 8)
    assert len(tree) == 9841
    assert _max_den_bits(evaluate(tree, PARAMS)) == 9842
