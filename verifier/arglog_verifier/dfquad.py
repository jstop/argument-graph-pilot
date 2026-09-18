"""DF-QuAD strengths over an append-only argument log (proposed semantics).

Second, independent implementation of SEMANTICS.md. Exact arithmetic with
``fractions.Fraction``; no floats anywhere. The exact "n/d" string is the
normative value, the 4-place decimal string is derived from it.
"""

from fractions import Fraction
import re

__all__ = ["DfQuadError", "evaluate", "aggregate", "combine", "exact", "display", "check_params"]


class DfQuadError(ValueError):
    """Raised for every refusal. ``code`` is the machine-readable reason."""

    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


# The only values this implementation agrees to run with. base_score is
# handled separately (any canonical rational in [0, 1]).
_FIXED = {
    "semantics": "df-quad",
    "aggregation": "probabilistic-sum",
    "influence": "df-quad-combination",
    "arithmetic": "exact-rational",
    "duplicates": "first-per-author-target-kind",
}
_DISPLAY = {"decimals": 4, "rounding": "half-even"}
_RATIONAL = re.compile(r"^(0|[1-9][0-9]*)/([1-9][0-9]*)$")


def _refuse(detail):
    raise DfQuadError("unsupported-parameter", detail)


def check_params(params):
    """Validate the genesis parameters; return the base score as a Fraction."""
    if not isinstance(params, dict):
        _refuse("params must be an object")
    wanted = set(_FIXED) | {"base_score", "display"}
    if set(params) != wanted:
        odd = sorted(set(params) ^ wanted)
        _refuse(f"missing or unknown keys: {odd}")
    for key, only in _FIXED.items():
        if params[key] != only:
            _refuse(f"{key}={params[key]!r}")
    shown = params["display"]
    if not isinstance(shown, dict) or set(shown) != set(_DISPLAY):
        _refuse("display")
    for key, only in _DISPLAY.items():
        # bool is an int in Python; True must not pass for a number.
        if type(shown[key]) is not type(only) or shown[key] != only:
            _refuse(f"display.{key}={shown[key]!r}")
    raw = params["base_score"]
    m = _RATIONAL.match(raw) if isinstance(raw, str) else None
    if m is None:
        _refuse(f"base_score={raw!r}")
    tau = Fraction(int(m.group(1)), int(m.group(2)))
    if exact(tau) != raw or tau > 1:
        _refuse(f"base_score={raw!r} (must be in lowest terms and within [0, 1])")
    return tau


def exact(value):
    """Normative serialization: lowest terms, positive denominator, 'n/d'."""
    return f"{value.numerator}/{value.denominator}"


def display(value):
    """Exactly four decimals, round-half-even, integer arithmetic only."""
    if value < 0:
        raise DfQuadError("internal", "negative strength")
    whole, rest = divmod(value.numerator * 10**4, value.denominator)
    twice = 2 * rest
    if twice > value.denominator or (twice == value.denominator and whole % 2 == 1):
        whole += 1
    units, frac = divmod(whole, 10**4)
    return f"{units}.{frac:04d}"


def aggregate(strengths):
    """F() = 0; F(v1..vn) = 1 - prod(1 - vi)."""
    remaining = Fraction(1)
    for v in strengths:
        remaining *= 1 - v
    return 1 - remaining


def combine(tau, va, vs):
    if va == vs:
        return tau
    if va > vs:
        return tau - tau * (va - vs)
    return tau + (1 - tau) * (vs - va)


def _validate(entries):
    """Check the log; return {id: position}."""
    everywhere = set()
    for e in entries:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            everywhere.add(e["id"])
    position = {}
    for index, e in enumerate(entries):
        if not isinstance(e, dict):
            raise DfQuadError("malformed-entry", f"entry {index}")
        ident, kind, author = e.get("id"), e.get("kind"), e.get("author")
        if not isinstance(ident, str) or not isinstance(author, str):
            raise DfQuadError("malformed-entry", f"entry {index}")
        if kind not in ("claim", "support", "attack"):
            raise DfQuadError("unknown-kind", f"{ident}: {kind!r}")
        if ident in position:
            raise DfQuadError("duplicate-id", ident)
        target = e.get("target")
        if kind == "claim":
            if target is not None:
                raise DfQuadError("claim-with-target", ident)
        else:
            if target is None:
                raise DfQuadError("edge-without-target", ident)
            if not isinstance(target, str):
                raise DfQuadError("malformed-entry", f"{ident}: target")
            if target == ident:
                raise DfQuadError("target-self", ident)
            if target not in position:
                if target in everywhere:
                    raise DfQuadError("target-not-earlier", f"{ident} -> {target}")
                raise DfQuadError("target-missing", f"{ident} -> {target}")
        position[ident] = index
    return position


def evaluate(entries, params):
    """Return one result dict per entry, in log order."""
    tau = check_params(params)
    entries = list(entries)
    _validate(entries)

    # Decide which edges count: earliest per (author, target, kind).
    seen = set()
    counted = {}
    incoming = {e["id"]: {"attack": [], "support": []} for e in entries}
    for e in entries:
        if e["kind"] == "claim":
            counted[e["id"]] = True
            continue
        key = (e["author"], e["target"], e["kind"])
        counted[e["id"]] = key not in seen
        if key not in seen:
            seen.add(key)
            incoming[e["target"]][e["kind"]].append(e["id"])

    # Everything pointing at an entry is later in the log, so walking the log
    # backwards meets each entry after all of its contributors.
    strength = {}
    for e in reversed(entries):
        mine = incoming[e["id"]]
        va = aggregate(strength[i] for i in mine["attack"])
        vs = aggregate(strength[i] for i in mine["support"])
        strength[e["id"]] = combine(tau, va, vs)

    return [
        {
            "id": e["id"],
            "strength": exact(strength[e["id"]]),
            "display": display(strength[e["id"]]),
            "counted": counted[e["id"]],
            "attackers": list(incoming[e["id"]]["attack"]),
            "supporters": list(incoming[e["id"]]["support"]),
        }
        for e in entries
    ]
