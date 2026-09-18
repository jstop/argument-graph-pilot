"""
What deserves attention now. Every rule here is PROPOSED (DESIGN.md D10),
and every number it uses comes from the declared pipeline (pipeline.py).

    score = weight x sum(points of the signals that fired)

Each rule is evaluated for each idea and leaves a Signal behind whether it
fired or not, with the inputs it looked at and, when it did not fire, why
not. That record is the trace (`focus why`): nothing is ranked for a
reason that cannot be read, and nothing is left out for one either.

Community strength is never turned into your confidence. It appears only
as pressure: "this stands low there and you rely on it here".
"""
import datetime as dt
import math
from dataclasses import dataclass, field
from fractions import Fraction
from urllib.parse import quote

from . import pipeline as pl

CONFIDENT = ("RELY", "NOTE")


@dataclass
class Signal:
    rule: str
    fired: bool
    points: float
    text: str                  # fired: the reason shown; not fired: why not
    inputs: dict = field(default_factory=dict)


@dataclass
class Item:
    key: str
    title: str
    detail: str
    weight: float
    weight_steps: list = field(default_factory=list)   # [(what, value)] arithmetic of the weight
    signals: list = field(default_factory=list)
    moves: list = field(default_factory=list)          # [(label, url-or-command)]
    hidden: str | None = None                          # why it is not eligible at all (snoozed)

    @property
    def reasons(self):
        return [(s.points, s.text) for s in self.signals if s.fired]

    @property
    def score(self) -> float:
        return round(self.weight * sum(s.points for s in self.signals if s.fired), 3)


def _days_since(iso, now):
    return None if not iso else (now - dt.datetime.fromisoformat(iso)).days


def weigh(idea, st, p) -> tuple[float, list]:
    w = p["weight"]
    wins, losses, dismissed = st["wins"].get(idea.id, 0), st["losses"].get(idea.id, 0), st["dismissed"].get(f"idea:{idea.id}", 0)
    steps = [("base", w["base"]),
             (f"{w['per_log2_dependents']:g} x log2(1 + {idea.dependents} ideas that rest on it)", round(w["per_log2_dependents"] * math.log2(1 + idea.dependents), 3)),
             (f"{w['per_net_comparison']:g} x (ranked over another {wins}x - under {losses}x)", w["per_net_comparison"] * (wins - losses))]
    raw = sum(v for _, v in steps)
    floored = max(w["floor"], raw)
    if floored != raw:
        steps.append((f"floor {w['floor']:g}", round(floored - raw, 3)))
    total = round(floored * w["dismissal_factor"] ** dismissed, 3)
    if dismissed:
        steps.append((f"x {w['dismissal_factor']:g} for each of {dismissed} dismissal(s)", round(total - floored, 3)))
    return total, steps


def weight(idea, st, p=None) -> float:
    return weigh(idea, st, p or pl.DEFAULT)[0]


def evaluate(ideas, st, community=None, now=None, p=None) -> list[Item]:
    """Every idea and every loose community claim, scored and traced. Unsorted, unfiltered."""
    p = p or pl.DEFAULT
    pts, th = p["signals"], p["thresholds"]
    low, high = Fraction(th["low"]), Fraction(th["high"])
    now = now or dt.datetime.now(dt.timezone.utc)
    by_said = community.by_said() if community else {}
    site = community.url if community and community.url else ""
    links_by_idea: dict[str, list] = {}
    for (idea_id, entry), link in st["links"].items():
        links_by_idea.setdefault(idea_id, []).append((entry, link["relation"]))
    clusters_in_play = {i.cluster for i in ideas if i.id in links_by_idea and i.cluster}
    items = []

    for idea in ideas:
        key = f"idea:{idea.id}"
        last = st["last"].get(key)
        w, steps = weigh(idea, st, p)
        it = Item(key=key, title=idea.claim, detail=f"{idea.id} · your stance {idea.stance} · {idea.dependents} idea(s) rest on it", weight=w, weight_steps=steps)
        if last and last["response"] == "snoozed" and last.get("until", "") > now.date().isoformat():
            it.hidden = f"snoozed until {last['until']}"
        seen_n = last.get("head_n", 0) if last else 0
        add = lambda rule, fired, text, **inputs: it.signals.append(Signal(rule, bool(fired) and pts[rule] > 0, pts[rule] if fired else 0.0,
                                                                         text if pts[rule] > 0 or not fired else f"(rule switched off in this pipeline) {text}", inputs))
        confident = idea.stance in CONFIDENT

        # ---- pressure from the community (only entries the verifier accepted) -----
        links = links_by_idea.get(idea.id, [])
        if not links:
            for rule in ("community_attack", "low_standing", "high_standing", "opposite_high"):
                add(rule, False, "not linked to any community entry" if community else "no community pulled")
        for entry_id, relation in links:
            e = by_said.get(entry_id)
            if e is None or not e.ok:
                add("community_attack", False, f"linked entry {entry_id[:12]}… " + ("is not in the pulled export" if e is None else "was REJECTED by the verifier, so it exerts no pressure"), entry=entry_id, relation=relation)
                continue
            against = "attack" if relation == "same" else "support"
            responses = community.responses_to(entry_id, against)
            fresh = [r for r in responses if r.n > seen_n and r.counted]
            for r in fresh[:th["max_attacks_shown"]]:
                verb = "attacked it" if relation == "same" else "backed the opposing claim"
                add("community_attack", True, f"{r.handle} {verb} in the community log (entry {r.n}): \"{r.text[:140]}\"", entry=r.said, entry_n=r.n, target=entry_id, relation=relation, you_last_looked_at_log_position=seen_n)
                it.moves += [(f"read entry {r.n}", f"{site}/entry/{r.said}"), (f"answer {r.handle} publicly (attack entry {r.n}; your phone signs)", f"{site}/start?kind=attack&target={r.said}")]
            if not fresh:
                add("community_attack", False, f"entry {e.n} has {len(responses)} counted {against}(s), none newer than log position {seen_n}, where you last looked", target=entry_id, relation=relation)
            standing = dict(entry_n=e.n, community_standing=str(e.strength), shown_as=e.display, your_stance=idea.stance, low=th["low"], high=th["high"], relation=relation)
            if relation == "same":
                add("low_standing", confident and e.strength < low, f"you hold this at {idea.stance}; in the community it stands at {e.display} (entry {e.n})" if confident and e.strength < low
                    else f"standing {e.display} is not below {th['low']}" if confident else f"you do not hold it confidently ({idea.stance})", **standing)
                if confident and e.strength < low:
                    it.moves.append((f"support entry {e.n} with your reason", f"{site}/start?kind=support&target={e.said}"))
                add("high_standing", (not confident) and e.strength > high, f"the community holds this at {e.display}; you hold it at {idea.stance}" if (not confident) and e.strength > high
                    else f"standing {e.display} is not above {th['high']}" if not confident else f"you already hold it confidently ({idea.stance})", **standing)
                if (not confident) and e.strength > high:
                    it.moves.append((f"see who supports entry {e.n} and why", f"{site}/entry/{e.said}"))
                add("opposite_high", False, f"applies only to an entry you linked as 'opposes'; entry {e.n} is linked as 'same'", entry_n=e.n, relation=relation)
            else:
                for rule in ("low_standing", "high_standing"):
                    add(rule, False, f"applies only to an entry you linked as 'same'; entry {e.n} is linked as 'opposes'", entry_n=e.n, relation=relation)
                add("opposite_high", confident and e.strength > high, f"the opposite claim stands at {e.display} in the community (entry {e.n}) while you hold this at {idea.stance}" if confident and e.strength > high
                    else f"the opposite claim stands at {e.display}, not above {th['high']}" if confident else f"you do not hold it confidently ({idea.stance})", **standing)
                if confident and e.strength > high:
                    it.moves.append((f"attack entry {e.n} with your reason", f"{site}/start?kind=attack&target={e.said}"))
        has_community_pressure = any(s.fired for s in it.signals)

        # ---- pressure from your own library -------------------------------------
        looked = _days_since(last["at"], now) if last else None
        resting = bool(last and last["response"] == "engaged" and (looked or 0) < th["rest_days"]) and not has_community_pressure
        rest = f"you looked at it {looked} day(s) ago; library signals rest for {th['rest_days']} days unless the community moves" if resting else None
        compromised = bool(idea.degraded_reason) and "unreviewed" not in (idea.degraded_reason or "")
        add("contested", idea.contested and not resting, rest or ("marked CONTESTED in your library: two of your own beliefs disagree" if idea.contested else "not contested"))
        add("contradicted", bool(idea.contradicted_by) and not resting, rest or (f"contradicted by your own: {', '.join(idea.contradicted_by[:3])}" if idea.contradicted_by else "no CONTRADICTS relationship"), contradicted_by=idea.contradicted_by)
        add("premise_compromised", compromised and not resting, rest or (f"its support is compromised: {idea.degraded_reason}" if compromised else "every premise stands"), premises=idea.premises, episteme_says=idea.degraded_reason)
        why_suspect = "nothing in your library supports it" if idea.unsupported else f"it has gone {idea.freshness}"
        add("suspect", idea.stance == "SUSPECT" and not compromised and not resting, rest or (f"SUSPECT in your library ({why_suspect}): verify it or let it go" if idea.stance == "SUSPECT" and not compromised
            else "already counted under premise_compromised" if idea.stance == "SUSPECT" else f"stance is {idea.stance}"), stance=idea.stance, freshness=idea.freshness, age_days=idea.age_days, unsupported=idea.unsupported)
        add("hypothesis", idea.stance == "HYPOTHESIS" and not resting, rest or ("still a hypothesis: this is where your understanding can move" if idea.stance == "HYPOTHESIS" else f"stance is {idea.stance}"), method=idea.method)
        add("unreviewed", (not idea.stood_behind) and not resting, rest or ("an agent wrote this and you have not yet stood behind it" if not idea.stood_behind else "you stand behind it"))
        nothing_else = not any(s.fired for s in it.signals)
        heavy = idea.dependents >= th["heavy_dependents"]
        unexamined = looked is None or looked > th["unexamined_days"]
        add("heavy_unexamined", nothing_else and heavy and unexamined and not resting,
            rest or (f"{idea.dependents} ideas rest on it and you have " + ("never examined it here" if looked is None else f"not examined it for {looked} days") if nothing_else and heavy and unexamined
                     else "another signal already fired" if not nothing_else else f"only {idea.dependents} idea(s) rest on it (needs {th['heavy_dependents']})" if not heavy else f"you examined it {looked} day(s) ago"),
            dependents=idea.dependents, last_examined_days_ago=looked)
        if any(s.fired for s in it.signals) and not has_community_pressure:
            it.moves.append(("open it in Episteme", f"episteme: {idea.id}"))

        # ---- outward: a position worth putting to the community --------------------
        conds = {"a community is pulled": bool(community), "not yet linked": idea.id not in links_by_idea, f"its cluster '{idea.cluster}' is already argued there": idea.cluster in clusters_in_play,
                 "you stand behind it": idea.stood_behind, "you hold it confidently": confident, f"at least {th['outward_min_dependents']} idea(s) rest on it": idea.dependents >= th["outward_min_dependents"]}
        ok = all(conds.values())
        add("outward", ok, f"you stand behind this, {idea.dependents} idea(s) rest on it, its topic is already argued in the community, and nobody has claimed it there" if ok
            else "not met: " + "; ".join(k for k, v in conds.items() if not v), **{k: v for k, v in conds.items()})
        if ok and pts["outward"] > 0:
            it.moves.append(("post it as a claim (your phone signs)", f"{site}/start?kind=claim&text={quote(idea.claim[:480])}"))
        if any(s.fired for s in it.signals):
            it.moves.append(("not now", f"focus snooze {idea.id} 14"))
        items.append(it)

    # ---- what the community argues and you hold nothing about ------------------------
    if community:
        linked = {entry for (_, entry) in st["links"]}
        for e in community.entries:
            if not (e.ok and e.kind == "claim") or e.said in linked:
                continue
            n = len(community.responses_to(e.said))
            it = Item(key=f"entry:{e.said}", title=e.text, detail=f"community entry {e.n} by {e.handle} · stands at {e.display}", weight=1.0, weight_steps=[("a community claim has no place in your library yet", 1.0)])
            if st["last"].get(it.key, {}).get("response") == "dismissed":
                it.hidden = "you dismissed it"
            extra = min(th["outside_max_extra"], pts["outside_per_response"] * n)
            it.signals.append(Signal("outside_base", pts["outside_base"] > 0, pts["outside_base"] + extra, f"argued in the community ({n} response(s)) and linked to nothing you hold", {"responses": n, "extra_points": extra}))
            it.moves += [("read it", f"{site}/entry/{e.said}"), ("link it to an idea of yours", f"focus link <idea> {e.said} same|opposes"), ("not mine to care about", f"focus dismiss entry:{e.said}")]
            items.append(it)
    return items


def select(items, p=None) -> list[Item]:
    p = p or pl.DEFAULT
    live = sorted((i for i in items if not i.hidden and i.score > 0), key=lambda i: (-i.score, i.key))
    top = live[:p["budget"]]
    # The outside world always gets one seat, or a busy library would never let it in.
    outside = next((i for i in live if i.key.startswith("entry:")), None)
    if p["outside_seat"] and outside and outside not in top and p["budget"] > 1:
        top = top[:p["budget"] - 1] + [outside]
    return top


def focus(ideas, st, community=None, now=None, budget: int | None = None, p=None) -> list[Item]:
    p = dict(p or pl.DEFAULT, **({"budget": budget} if budget else {}))
    return select(evaluate(ideas, st, community, now, p), p)
