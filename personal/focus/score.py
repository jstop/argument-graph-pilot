"""
What deserves attention now. Every rule here is PROPOSED (DESIGN.md D10).

    score = weight x sum(signals)

weight   how much rests on the idea: 1 + log2(1 + ideas that depend on it)
         + 0.5 x (times you ranked it over another - times under), halved
         for each time you dismissed it as not important. Floor 0.25.
signals  named, each with points and a sentence. Nothing is ranked for a
         reason that is not printed next to it. An idea with no signal is
         not shown: there is nothing to do about it.

Community strength is never turned into your confidence. It appears only
as pressure: "this stands low there and you rely on it here".
"""
import datetime as dt
import math
from dataclasses import dataclass, field
from fractions import Fraction
from urllib.parse import quote

CONFIDENT = ("RELY", "NOTE")
LOW, HIGH = Fraction(1, 3), Fraction(2, 3)
REST_DAYS_AFTER_ENGAGING = 7
UNEXAMINED_DAYS = 90


@dataclass
class Item:
    key: str
    title: str
    detail: str
    weight: float
    reasons: list = field(default_factory=list)     # [(points, sentence)]
    moves: list = field(default_factory=list)       # [(label, url-or-command)]

    @property
    def score(self) -> float:
        return round(self.weight * sum(p for p, _ in self.reasons), 3)


def _days_since(iso: str | None, now: dt.datetime) -> int | None:
    if not iso:
        return None
    return (now - dt.datetime.fromisoformat(iso)).days


def weight(idea, st) -> float:
    key = f"idea:{idea.id}"
    w = 1 + math.log2(1 + idea.dependents) + 0.5 * (st["wins"].get(idea.id, 0) - st["losses"].get(idea.id, 0))
    return round(max(0.25, w) * 0.5 ** st["dismissed"].get(key, 0), 3)


def focus(ideas, st, community=None, now: dt.datetime | None = None, budget: int = 5) -> list[Item]:
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
        if last and last["response"] == "snoozed" and last.get("until", "") > now.date().isoformat():
            continue
        seen_n = last.get("head_n", 0) if last else 0
        it = Item(key=key, title=idea.claim, detail=f"{idea.id} · your stance {idea.stance} · {idea.dependents} idea(s) rest on it", weight=weight(idea, st))

        # ---- pressure from the community (only verified entries) -----------
        for entry_id, relation in links_by_idea.get(idea.id, []):
            e = by_said.get(entry_id)
            if e is None or not e.ok:
                continue
            against = "attack" if relation == "same" else "support"
            fresh = [r for r in community.responses_to(entry_id, against) if r.n > seen_n and r.counted]
            for r in fresh[:3]:
                verb = "attacked it" if relation == "same" else "backed the opposing claim"
                it.reasons.append((3.0, f"{r.handle} {verb} in the community log (entry {r.n}): \"{r.text[:140]}\""))
                it.moves.append((f"read entry {r.n}", f"{site}/entry/{r.said}"))
                it.moves.append((f"answer {r.handle} publicly (attack entry {r.n}; your phone signs)", f"{site}/start?kind=attack&target={r.said}"))
            confident = idea.stance in CONFIDENT
            if relation == "same" and confident and e.strength is not None and e.strength < LOW:
                it.reasons.append((2.0, f"you hold this at {idea.stance}; in the community it stands at {e.display} (entry {e.n})"))
                it.moves.append((f"support entry {e.n} with your reason", f"{site}/start?kind=support&target={e.said}"))
            if relation == "same" and not confident and e.strength is not None and e.strength > HIGH:
                it.reasons.append((1.5, f"the community holds this at {e.display}; you hold it at {idea.stance}"))
                it.moves.append((f"see who supports entry {e.n} and why", f"{site}/entry/{e.said}"))
            if relation == "opposes" and confident and e.strength is not None and e.strength > HIGH:
                it.reasons.append((2.0, f"the opposite claim stands at {e.display} in the community (entry {e.n}) while you hold this at {idea.stance}"))
                it.moves.append((f"attack entry {e.n} with your reason", f"{site}/start?kind=attack&target={e.said}"))
        has_community_pressure = bool(it.reasons)

        # ---- pressure from your own library ---------------------------------
        resting = last and last["response"] == "engaged" and (_days_since(last["at"], now) or 0) < REST_DAYS_AFTER_ENGAGING
        if not resting or has_community_pressure:
            if idea.contested:
                it.reasons.append((3.0, "marked CONTESTED in your library: two of your own beliefs disagree"))
            if idea.contradicted_by:
                it.reasons.append((2.0, f"contradicted by your own: {', '.join(idea.contradicted_by[:3])}"))
            if idea.degraded_reason and "unreviewed" not in idea.degraded_reason:
                it.reasons.append((2.5, f"its support is compromised: {idea.degraded_reason}"))
            elif idea.stance == "SUSPECT":
                why = "nothing in your library supports it" if idea.unsupported else f"it has gone {idea.freshness}"
                it.reasons.append((1.5, f"SUSPECT in your library ({why}): verify it or let it go"))
            if idea.stance == "HYPOTHESIS":
                it.reasons.append((1.0, "still a hypothesis: this is where your understanding can move"))
            if not idea.stood_behind:
                it.reasons.append((0.5, "an agent wrote this and you have not yet stood behind it"))
            looked = _days_since(last["at"], now) if last else None
            if not it.reasons and idea.dependents >= 3 and (looked is None or looked > UNEXAMINED_DAYS):
                it.reasons.append((1.0, f"{idea.dependents} ideas rest on it and you have " + ("never examined it here" if looked is None else f"not examined it for {looked} days")))
            if it.reasons and not has_community_pressure:
                it.moves.append(("open it in Episteme", f"episteme: {idea.id}"))

        # ---- outward: a position worth putting to the community ---------------
        if community and idea.id not in links_by_idea and idea.cluster in clusters_in_play and idea.stood_behind \
                and idea.stance in CONFIDENT and idea.dependents >= 1:
            it.reasons.append((1.0, f"you stand behind this, {idea.dependents} idea(s) rest on it, its topic is already argued in the community, and nobody has claimed it there"))
            it.moves.append(("post it as a claim (your phone signs)", f"{site}/start?kind=claim&text={quote(idea.claim[:480])}"))

        if it.reasons:
            it.moves.append(("not now", f"focus snooze {idea.id} 14"))
            items.append(it)

    # ---- one slot for what the community argues and you hold nothing about ------
    if community:
        linked = {entry for (_, entry) in st["links"]}
        loose = [e for e in community.entries if e.ok and e.kind == "claim" and e.said not in linked
                 and st["last"].get(f"entry:{e.said}", {}).get("response") != "dismissed"]
        loose.sort(key=lambda e: (-len(community.responses_to(e.said)), e.n))
        for e in loose[:1]:
            n = len(community.responses_to(e.said))
            it = Item(key=f"entry:{e.said}", title=e.text, detail=f"community entry {e.n} by {e.handle} · stands at {e.display}", weight=1.0)
            it.reasons.append((1.0 + min(2.0, 0.5 * n), f"argued in the community ({n} response(s)) and linked to nothing you hold"))
            it.moves += [("read it", f"{site}/entry/{e.said}"), ("link it to an idea of yours", f"focus link <idea> {e.said} same|opposes"),
                         ("not mine to care about", f"focus dismiss entry:{e.said}")]
            items.append(it)

    items.sort(key=lambda i: (-i.score, i.key))
    # The outside world always gets one seat, or a busy library would never let it in.
    top = items[:budget]
    outside = next((i for i in items if i.key.startswith("entry:")), None)
    if outside and outside not in top and budget > 1:
        top = top[:budget - 1] + [outside]
    return top
