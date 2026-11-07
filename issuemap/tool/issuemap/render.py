"""Render a debate map as one self-contained HTML page.

Layout: the cruxes first (most decisive at top), each with its sides; every
side lists its points; every point opens to the claims behind it, and every
claim shows the exact quote, its author, a link to the comment, and whether
the quote was mechanically verified.
"""
import html
import json

CSS = """
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b675f;--line:#e4e0d8;--acc:#9a4b16;--ok:#2f6b3a;--bad:#a12c2c;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece9e2;--mut:#9d978b;--line:#2f2c27;--acc:#e09a62;--ok:#7fc08a;--bad:#e57e7e;--card:#1e1d1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-serif,Georgia,serif}
main{max-width:860px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:1.7rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.15rem;margin:36px 0 10px;font-family:ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;text-transform:uppercase;color:var(--mut)}
.meta{color:var(--mut);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}.meta code{font-size:12px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.stat{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:13px ui-sans-serif,system-ui,sans-serif;background:var(--card)}.stat b{font-size:16px;display:block}
.crux{border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:10px;padding:14px 16px;margin:14px 0;background:var(--card)}
.crux h3{margin:0 0 6px;font-size:1.12rem}.rank{color:var(--acc);font:600 13px ui-sans-serif,system-ui,sans-serif;margin-right:6px}
.why{margin:4px 0 10px;color:var(--mut)}.sides{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.side{border-top:2px solid var(--line);padding-top:8px}.side h4{margin:0 0 6px;font:600 14px ui-sans-serif,system-ui,sans-serif}
details.point{margin:6px 0;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--bg)}
details.point>summary{cursor:pointer;list-style:none}details.point>summary::-webkit-details-marker{display:none}
.pid{font:600 11px ui-sans-serif,system-ui,sans-serif;color:var(--mut);margin-right:6px}.w{font:12px ui-sans-serif,system-ui,sans-serif;color:var(--mut);white-space:nowrap}
.claim{border-left:2px solid var(--line);margin:8px 0 8px 4px;padding:2px 0 2px 10px;font-size:14.5px}
.claim blockquote{margin:4px 0;font-style:italic}.claim .by{font:12px ui-sans-serif,system-ui,sans-serif;color:var(--mut)}
.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:var(--acc)}
.edge{font:12.5px ui-sans-serif,system-ui,sans-serif;color:var(--mut);margin:3px 0}
.settle{font:13px ui-sans-serif,system-ui,sans-serif;color:var(--mut);margin-top:10px}
input#q{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:15px ui-sans-serif,system-ui,sans-serif}
.hide{display:none}
"""

JS = """
const q=document.getElementById('q');
q&&q.addEventListener('input',()=>{const t=q.value.toLowerCase();
document.querySelectorAll('#all details.point').forEach(d=>{d.classList.toggle('hide',t&&!d.textContent.toLowerCase().includes(t))})});
"""


def e(s):
    return html.escape(str(s or ""))


def _claim_html(cl, comments):
    meta = comments.get(cl["comment_id"], {})
    mark = ('<span class="ok" title="Quote found verbatim in the comment">&#10003; verified</span>'
            if cl.get("quote_verified") else
            '<span class="bad" title="Quote not found verbatim">&#10007; quote not found</span>')
    return (f'<div class="claim">{e(cl["claim"])}'
            f'<blockquote>&ldquo;{e(cl.get("quote"))}&rdquo;</blockquote>'
            f'<div class="by">{e(cl.get("author") or meta.get("author"))}, {e(meta.get("date"))} &middot; '
            f'<a href="{e(meta.get("url"))}" target="_blank" rel="noopener">comment</a> &middot; {mark}</div></div>')


def _point_html(pid, pt, claims_by_id, comments, edges_out):
    cls = [claims_by_id[c] for c in pt["claims"] if c in claims_by_id]
    people = len({c.get("author") for c in cls})
    rel = "".join(f'<div class="edge">{e(x["type"])} <b>{e(x["to"])}</b>: {e(x.get("why"))}</div>'
                  for x in edges_out.get(pid, []))
    return (f'<details class="point" id="{e(pid)}"><summary><span class="pid">{e(pid)}</span>'
            f'{e(pt["statement"])} <span class="w">&middot; {len(cls)} claims, {people} people</span></summary>'
            f'{rel}{"".join(_claim_html(c, comments) for c in cls)}</details>')


def render(m, extra_html=""):
    claims_by_id = {c["id"]: c for c in m["claims"]}
    edges_out = {}
    for x in m["edges"]:
        edges_out.setdefault(x["from"], []).append(x)
    pt = lambda pid: _point_html(pid, m["points"][pid], claims_by_id, m["comments"], edges_out)
    qc = m["quote_check"]
    people = len({c.get("author") for c in m["claims"]})
    cruxes = []
    for i, c in enumerate(m["cruxes"], 1):
        sides = "".join(
            f'<div class="side"><h4>{e(s["answer"])}</h4>{"".join(pt(p) for p in s["points"])}</div>'
            for s in c.get("sides", []))
        cruxes.append(
            f'<section class="crux"><h3><span class="rank">#{i}</span>{e(c["question"])}</h3>'
            f'<p class="why">{e(c.get("why_decisive"))}</p><div class="sides">{sides}</div>'
            f'<div class="settle"><b>What would settle it:</b> {e(c.get("settles_by"))}</div></section>')
    ranked = sorted(m["points"], key=lambda p: -len(m["points"][p]["claims"]))
    sources = " ".join(f'<a href="{e(u.strip())}">{e(u.strip())}</a>' for u in m["source"].split("+"))
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(m["title"])} — debate map</title>
<style>{CSS}</style></head><body><main>
<h1>{e(m["title"])}</h1>
<div class="meta">Debate map of {sources}. Every line links to the comment it came from.<br>
Frozen corpus <code>sha256:{e(m["corpus_sha256"][:16])}…</code>; {len(m["excluded"])} summary comments excluded so they couldn't steer the map.</div>
<div class="stats"><div class="stat"><b>{len(m["comments"])}</b>comments</div><div class="stat"><b>{people}</b>people making claims</div>
<div class="stat"><b>{len(m["claims"])}</b>claims</div><div class="stat"><b>{len(m["points"])}</b>distinct points</div>
<div class="stat"><b>{qc["verified"]}/{qc["verified"] + qc["failed"]}</b>quotes verified</div></div>
{extra_html}
<h2>The cruxes</h2>{"".join(cruxes)}
<h2>Every point</h2><input id="q" placeholder="Filter points and quotes…" aria-label="Filter points">
<div id="all">{"".join(pt(p) for p in ranked)}</div>
<p class="meta" style="margin-top:30px">Made with issuemap. The model acts as scribe, not judge: it records and groups arguments and names the cruxes, but does not say who was right.</p>
</main><script>{JS}</script></body></html>"""


def render_file(map_path, out_path, extra_html=""):
    with open(map_path) as f:
        m = json.load(f)
    with open(out_path, "w") as f:
        f.write(render(m, extra_html))
