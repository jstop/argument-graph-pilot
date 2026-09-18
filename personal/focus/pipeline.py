"""
The attention pipeline's parameters, declared rather than buried in code
(the same idea as the community log declaring its semantics in its first
record). The active pipeline is whatever the last PipelineAdopted event in
the focus log says; its full text is stored in that event, so an old list
can always be recomputed with the rules that produced it. Identified by
the SHA-256 of its canonical JSON.

Setting a signal's points to 0 switches that rule off. Unknown keys are
refused: a typo must not silently do nothing.
"""
import hashlib
import json
from fractions import Fraction

DEFAULT = {
    "version": 1,
    "budget": 5,
    "outside_seat": True,
    "weight": {"base": 1.0, "per_log2_dependents": 1.0, "per_net_comparison": 0.5, "dismissal_factor": 0.5, "floor": 0.25},
    "signals": {
        "community_attack": 3.0, "low_standing": 2.0, "high_standing": 1.5, "opposite_high": 2.0,
        "contested": 3.0, "contradicted": 2.0, "premise_compromised": 2.5, "suspect": 1.5, "hypothesis": 1.0,
        "unreviewed": 0.5, "heavy_unexamined": 1.0, "outward": 1.0, "outside_base": 1.0, "outside_per_response": 0.5,
    },
    "thresholds": {"low": "1/3", "high": "2/3", "max_attacks_shown": 3, "rest_days": 7, "unexamined_days": 90,
                   "heavy_dependents": 3, "outward_min_dependents": 1, "outside_max_extra": 2.0},
}

WHAT = {   # one line per rule, shown in traces and on the pipeline page
    "community_attack": "a verified community entry attacks something you hold (or backs its opposite), and you have not looked since",
    "low_standing": "you hold it confidently (RELY/NOTE) and the linked community claim stands below `low`",
    "high_standing": "you doubt it and the linked community claim stands above `high`",
    "opposite_high": "you hold it confidently and the opposite claim stands above `high` in the community",
    "contested": "Episteme marks it CONTESTED",
    "contradicted": "another of your own beliefs CONTRADICTS it",
    "premise_compromised": "a premise it rests on is contested, retired or unsupported (Episteme's dependency cap)",
    "suspect": "its stance is SUSPECT (stale, or nothing supports it)",
    "hypothesis": "its stance is HYPOTHESIS: still movable",
    "unreviewed": "an agent wrote it and you have not stood behind it",
    "heavy_unexamined": "many ideas rest on it, nothing else is wrong, and you have not examined it here for `unexamined_days`",
    "outward": "you stand behind it, ideas rest on it, its topic (cluster) is already argued in the community, nobody claimed it there",
    "outside_base": "a community claim linked to nothing you hold (plus `outside_per_response` per response, capped)",
}


def canonical(p: dict) -> str:
    return json.dumps(p, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(p: dict) -> str:
    return hashlib.sha256(canonical(p).encode("utf-8")).hexdigest()


def validate(p: dict) -> dict:
    def same_keys(got, want, where):
        if not isinstance(got, dict) or set(got) != set(want):
            extra, missing = set(got or {}) - set(want), set(want) - set(got or {})
            raise ValueError(f"pipeline {where}: unknown {sorted(extra)} missing {sorted(missing)}")
    same_keys(p, DEFAULT, "top level")
    for section in ("weight", "signals", "thresholds"):
        same_keys(p[section], DEFAULT[section], section)
    if p["version"] != 1:
        raise ValueError("pipeline version must be 1")
    for k, v in {**p["weight"], **p["signals"]}.items():
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
            raise ValueError(f"pipeline: {k} must be a non-negative number")
    lo, hi = Fraction(p["thresholds"]["low"]), Fraction(p["thresholds"]["high"])
    if not (0 <= lo < hi <= 1):
        raise ValueError("pipeline: need 0 <= low < high <= 1")
    if not isinstance(p["budget"], int) or p["budget"] < 1:
        raise ValueError("pipeline: budget must be a positive integer")
    return p


def active(state: dict) -> dict:
    return state["pipelines"][-1]["pipeline"] if state.get("pipelines") else DEFAULT
