"""One item, all the way down: the score's arithmetic, every rule (fired or not, on what inputs), what your library
holds behind the idea, what the verifier found about each linked community entry, and what you did with it before."""
from . import pipeline as pl


def build(key, everything, top, snap, comm, st, p, log) -> dict:
    it = next((i for i in everything if i.key == key), None)
    if it is None:
        raise LookupError(f"no item {key} (python -m focus ideas / entries)")
    rank = next((n for n, i in enumerate(sorted((x for x in everything if not x.hidden and x.score > 0), key=lambda i: (-i.score, i.key)), 1) if i.key == key), None)
    t = {"key": key, "title": it.title, "detail": it.detail, "score": it.score, "rank": rank, "shown": it in top, "hidden": it.hidden,
         "budget": p["budget"], "pipeline": pl.digest(p), "weight": it.weight, "weight_steps": it.weight_steps,
         "signals": [{"rule": s.rule, "what": pl.WHAT.get(s.rule, ""), "fired": s.fired, "points": s.points, "text": s.text, "inputs": s.inputs} for s in it.signals],
         "library": None, "community": [], "read_from": {"library": snap.db, "library_sequence": snap.head_sequence, "library_hash": snap.head_hash,
                                                        "community": (st["pulls"][-1] if st["pulls"] else None)},
         "history": [{"at": e["at"], **e["data"]} for e in log.events if e["type"] in ("Responded", "Linked", "Unlinked") and (e["data"].get("item") == key or f"idea:{e['data'].get('idea')}" == key)]
                    + [{"at": e["at"], "compared": e["data"]} for e in log.events if e["type"] == "Compared" and key in (f"idea:{e['data']['over']}", f"idea:{e['data']['under']}")],
         "appearances": [{"at": l["at"], "position": [k for k, _ in l["list"]].index(key) + 1, "score": dict(map(tuple, l["list"]))[key]} for l in st["lists"] if key in [k for k, _ in l["list"]]]}
    if key.startswith("idea:"):
        idea_id = key[5:]
        t["library"] = snap.detail(idea_id)
        entries = [(entry, link["relation"]) for (i, entry), link in st["links"].items() if i == idea_id]
    else:
        entries = [(key[6:], "—")]
    by = comm.by_said() if comm else {}
    for said, relation in entries:
        e = by.get(said)
        t["community"].append({"said": said, "relation": relation, "found": e is not None, **({} if e is None else {
            "n": e.n, "kind": e.kind, "by": e.handle, "author": e.author, "text": e.text, "accepted_by_verifier": e.ok, "standing": str(e.strength) if e.strength is not None else None,
            "shown_as": e.display, "checks": e.checks, "url": f"{comm.url}/entry/{said}" if comm.url else None,
            "responses": [{"n": r.n, "kind": r.kind, "by": r.handle, "text": r.text, "standing": r.display, "counted": r.counted} for r in comm.responses_to(said)]})})
    return t


def text(t: dict) -> str:
    o = [t["title"], f"  {t['detail']}", ""]
    o.append(f"SCORE {t['score']:g} = weight {t['weight']:g} x {sum(s['points'] for s in t['signals'] if s['fired']):g} points"
             + (f"   rank {t['rank']}, " + ("SHOWN" if t["shown"] else "not shown: the last seat is kept for the outside world" if t["rank"] <= t["budget"] else "not shown") + f" (budget {t['budget']})" if t["rank"] else "   not ranked: " + (t["hidden"] or "no signal fired")))
    o.append(f"  pipeline {t['pipeline'][:12]}…   library at event {t['read_from']['library_sequence']} ({(t['read_from']['library_hash'] or '')[:19]}…)"
             + (f"   community export {t['read_from']['community']['digest'][:12]}… ({'verified' if t['read_from']['community']['verified'] else 'NOT verified'})" if t["read_from"]["community"] else "   no community"))
    o += ["", "WEIGHT"] + [f"  {v:+g}  {what}" for what, v in t["weight_steps"]] + [f"  = {t['weight']:g}"]
    o += ["", "RULES (every one, fired or not)"]
    for s in t["signals"]:
        o.append(f"  [{'x' if s['fired'] else ' '}] {s['rule']:<20} {'+' + format(s['points'], 'g') if s['fired'] else '  '}  {s['text']}")
        if s["inputs"]:
            o.append("        looked at: " + ", ".join(f"{k}={v}" for k, v in s["inputs"].items()))
    lib = t["library"]
    if lib:
        o += ["", "WHAT YOUR LIBRARY HOLDS BEHIND IT",
              f"  stance {lib['stance']} ({lib['guidance']}) · method {lib['method']} · {lib['volatility']}, {lib['freshness']}, age {lib['age_days']} days"
              + (f" · {lib['degraded_reason']}" if lib["degraded_reason"] else ""),
              f"  written by {lib['authorship'].get('composed_by', '?')}; stood behind by {lib['authorship'].get('stood_behind_by') or 'nobody yet'}"]
        o += [f"  wording {h['at']} ({h['origin']}, {h['actor']}): {h['claim'][:120]}" for h in lib["claim_history"]]
        o += [f"  rests on   {p['id']} [{p['stance']}] {p['claim'][:90]}" for p in lib["premises"]] or ["  rests on   nothing (no premises)"]
        o.append(f"  carries    {len(lib['dependents'])}: {', '.join(lib['dependents'][:8])}{' …' if len(lib['dependents']) > 8 else ''}")
        o += [f"  evidence   {e['id']} {e['durability']} {e['media_type']} author={e['author']} recorded by {e['recorded_by']} {e['uri'] or ''}" for e in lib["evidence"]] or ["  evidence   none"]
        o += [f"  quote      \"{(g['quote'] or '')[:160]}\"  ({g['evidence_id']})" for g in lib["grounding"]]
    for c in t["community"]:
        o += ["", f"COMMUNITY ENTRY {c['said']}  (you said it {c['relation']})"]
        if not c["found"]:
            o.append("  not in the pulled export")
            continue
        o.append(f"  #{c['n']} {c['kind']} by {c['by']} ({c['author'][:16]}…): \"{c['text'][:160]}\"")
        o.append(f"  verifier: {'ACCEPTED' if c['accepted_by_verifier'] else 'REJECTED'}; stands at {c['shown_as']} (exactly {c['standing']})   {c['url'] or ''}")
        o += [f"    {'ok  ' if ok else 'FAIL'} {name}: {detail}" for name, ok, detail in c["checks"]]
        o += [f"    <- #{r['n']} {r['kind']} by {r['by']} at {r['standing']}{'' if r['counted'] else ' (not counted)'}: \"{r['text'][:110]}\"" for r in c["responses"]]
    if t["history"] or t["appearances"]:
        o += ["", "HISTORY"] + [f"  {a['at'][:16]} shown at position {a['position']} with score {a['score']:g}" for a in t["appearances"]]
        o += ["  " + h["at"][:16] + " " + ", ".join(f"{k}={v}" for k, v in h.items() if k != "at") for h in t["history"]]
    return "\n".join(o)
