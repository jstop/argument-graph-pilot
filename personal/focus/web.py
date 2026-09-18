"""
Everything `python -m focus ...` can do, as server-rendered pages. Binds to
127.0.0.1 only: it shows private ideas. Because the pages also CHANGE
things (links, responses, the active pipeline), every POST must carry a
token minted when the server started, and every request must be addressed
to 127.0.0.1/localhost: another site open in the same browser can make the
browser send a request here, but it cannot read the token, and a rebinding
hostname is refused.

    /            the list                 /ideas       find, link, compare
    /why?key=    one item, all the way    /community   pull, entries, links
    /pipeline    edit -> try -> replay -> adopt        /history   every list, audited
"""
import datetime as dt
import html
import json
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import audit as au, community as com, library, pipeline as pl, trace

STYLE = """
:root{color-scheme:light dark;--line:#8886;--bad:#b3261e;--ok:#1a7f37}
body{font:16px/1.5 system-ui,sans-serif;max-width:58rem;margin:0 auto;padding:1rem}
h1{font-size:1.4rem;margin:.6rem 0 0}h2{font-size:1.1rem;margin-top:1.6rem}.sub{opacity:.75;font-size:.9rem}
nav a{margin-right:1rem}nav{border-bottom:1px solid var(--line);padding-bottom:.5rem}
.item{border:1px solid var(--line);border-radius:.5rem;padding:.8rem 1rem;margin:1rem 0}
.item h2{font-size:1.05rem;margin:0 0 .2rem}.score{float:right;font-weight:600;font-variant-numeric:tabular-nums}
ul{margin:.4rem 0;padding-left:1.2rem}li small{opacity:.7}
a,button,input,select{color:inherit;font:inherit}button{padding:.25rem .7rem;border:1px solid var(--line);border-radius:.4rem;background:none;cursor:pointer}
input,select{padding:.2rem .4rem;border:1px solid var(--line);border-radius:.3rem;background:none;max-width:100%}input[type=number]{width:5.5rem}
form{display:inline}.mono{font-family:ui-monospace,monospace;font-size:.8rem;overflow-wrap:anywhere}.warn{color:var(--bad)}.good{color:var(--ok)}
table{border-collapse:collapse;width:100%}td,th{padding:.3rem .5rem;vertical-align:top;border-bottom:1px solid var(--line);text-align:left}
tr.off{opacity:.55}pre{white-space:pre-wrap;overflow-wrap:anywhere}.flash{border:1px solid var(--line);border-radius:.4rem;padding:.4rem .7rem;margin:.6rem 0}
"""
esc = lambda s: html.escape(str(s), quote=True)
NAV = '<nav><a href="/">Focus</a><a href="/ideas">My ideas</a><a href="/community">Community</a><a href="/pipeline">Rules</a><a href="/history">History</a></nav>'


def shell(title, body, flash="") -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{esc(title)}</title>'
            f'<style>{STYLE}</style></head><body>{NAV}' + (f'<div class="flash">{esc(flash)}</div>' if flash else "") + f'<h1>{esc(title)}</h1>{body}</body></html>')


class UI:
    def __init__(self, args, log):
        self.args, self.log, self.token = args, log, secrets.token_urlsafe(24)

    # ---- small pieces -----------------------------------------------------------
    def form(self, action, inner, back="/") -> str:
        return f'<form method="post" action="{action}"><input type="hidden" name="token" value="{self.token}"><input type="hidden" name="back" value="{esc(back)}">{inner}</form>'

    def respond_buttons(self, key, back="/") -> str:
        return " ".join(self.form("/respond", f'<input type="hidden" name="item" value="{esc(key)}"><input type="hidden" name="days" value="{d}"><button name="response" value="{v}">{label}</button>', back)
                        for v, label, d in (("engaged", "I looked at it", 0), ("snoozed", "Not now (14 days)", 14), ("snoozed", "Not for 60 days", 60), ("dismissed", "Not important", 0)))

    def ideas_datalist(self, ideas) -> str:
        return '<datalist id="ideas">' + "".join(f'<option value="{esc(i.id)}">{esc(i.claim[:90])}</option>' for i in ideas) + "</datalist>"

    def community(self):
        st = self.log.state()
        return com.load_pulled(self.log.dir, st["pulls"][-1]) if st["pulls"] else None

    # ---- pages --------------------------------------------------------------------
    def home(self, flash="") -> str:
        top, _, _, comm, _ = au.produce(self.args, self.log)
        def move(label, target):
            return f'<li><a href="{esc(target)}" target="_blank" rel="noopener">{esc(label)}</a></li>' if target.startswith("http") else ""
        def item(it):
            return (f'<div class="item"><span class="score" title="weight {it.weight} × points">{it.score:g}</span><h2>{esc(it.title)}</h2>'
                    f'<div class="sub">{esc(it.detail)} · weight {it.weight:g} · <a href="/why?key={quote(it.key)}">how this got here, and what you can do with it</a></div>'
                    f'<ul>{"".join(f"<li>{esc(why)} <small>+{p:g}</small></li>" for p, why in it.reasons)}</ul>'
                    f'<ul>{"".join(move(l, t) for l, t in it.moves)}</ul>{self.respond_buttons(it.key)}</div>')
        if comm is None:
            head = '<p class="warn">No community pulled yet. <a href="/community">Pull one</a>.</p>'
        else:
            head = (f'<p class="sub">Community <a href="{esc(comm.url)}">{esc(comm.url)}</a>: {len(comm.entries)} entries up to #{comm.head_n}, '
                    + ('independently verified. ' if comm.verified else f'<span class="warn">NOT verified: {esc("; ".join(comm.problems[:3]))}</span> ') + '<a href="/community">pull again</a></p>')
        return shell("What deserves your attention", f'<p class="sub">From your own library and the community log. The number is weight × the points shown. Served on this machine only.</p>{head}'
                     + ("".join(item(i) for i in top) or "<p>Nothing is pressing. Go learn something new.</p>"), flash)

    def why(self, key, flash="") -> str:
        top, everything, snap, comm, p = au.produce(self.args, self.log, record=False)
        st = self.log.state()
        t = trace.build(key, everything, top, snap, comm, st, p, self.log)
        back = f"/why?key={quote(key)}"
        rules = "".join(f'<tr class="{"" if s["fired"] else "off"}"><td>{"●" if s["fired"] else "○"}</td><td class="mono">{esc(s["rule"])}</td><td>{("+" + format(s["points"], "g")) if s["fired"] else ""}</td>'
                        f'<td>{esc(s["text"])}<div class="sub">rule: {esc(s["what"])}</div>' + (f'<div class="sub mono">looked at: {esc(", ".join(f"{k}={v}" for k, v in s["inputs"].items()))}</div>' if s["inputs"] else "") + "</td></tr>" for s in t["signals"])
        acts = f"<h2>Do something with it</h2><p>{self.respond_buttons(key, back)}</p>"
        if key.startswith("idea:"):
            idea = key[5:]
            entries = [e for e in (comm.entries if comm else []) if e.ok]
            linked = [(entry, l["relation"]) for (i, entry), l in st["links"].items() if i == idea]
            acts += "".join("<p>Linked to community entry <span class='mono'>" + esc(entry[:16]) + f"…</span> as <b>{esc(rel)}</b> "
                            + self.form("/unlink", f'<input type="hidden" name="idea" value="{esc(idea)}"><input type="hidden" name="entry" value="{esc(entry)}"><button>Unlink</button>', back) + "</p>" for entry, rel in linked)
            if entries:
                opts = "".join(f'<option value="{esc(e.said)}">#{e.n} {esc(e.kind)} by {esc(e.handle)}: {esc(e.text[:70])}</option>' for e in entries)
                acts += "<p>" + self.form("/link", f'<input type="hidden" name="idea" value="{esc(idea)}">This community entry <select name="entry">{opts}</select> says '
                                          '<select name="relation"><option value="same">what I hold</option><option value="opposes">the opposite</option></select> <button>Link</button>', back) + "</p>"
            acts += "<p>" + self.form("/over", f'<input type="hidden" name="over" value="{esc(idea)}">I hold this more firmly, or find it more important, than <input name="under" list="ideas" placeholder="idea id" required> <button>Record</button>', back) \
                    + self.ideas_datalist(snap.ideas) + "</p>"
        else:
            acts += "<p>" + self.form("/link", f'<input type="hidden" name="entry" value="{esc(key[6:])}">This entry says <select name="relation"><option value="same">what I hold</option><option value="opposes">the opposite of</option></select> '
                                      'in my idea <input name="idea" list="ideas" placeholder="idea id" required> <button>Link</button>', back) + self.ideas_datalist(snap.ideas) + "</p>"
        return shell(t["title"], f'<p class="sub">{esc(t["detail"])}</p>{acts}<h2>Every rule, fired or not</h2><table>{rules}</table>'
                     f'<h2>The whole derivation</h2><pre class="mono">{esc(trace.text(t))}</pre>', flash)

    def ideas(self, q="", flash="") -> str:
        ideas = library.snapshot(root=self.args.root, branch=self.args.branch, db_path=getattr(self.args, "db_path", None)).ideas
        st = self.log.state()
        linked = {i for (i, _) in st["links"]}
        words = q.lower().split()
        hits = [i for i in ideas if all(w in (i.id + " " + i.claim + " " + (i.cluster or "")).lower() for w in words)]
        hits.sort(key=lambda i: (-i.dependents, i.id))
        rows = "".join(f'<tr><td><a href="/why?key={quote("idea:" + i.id)}">{esc(i.claim[:160])}</a><div class="sub mono">{esc(i.id)} · {esc(i.cluster or "")}</div></td>'
                       f'<td>{esc(i.stance)}</td><td>{i.dependents}</td><td>{"linked" if i.id in linked else ""}</td><td>{st["wins"].get(i.id, 0)}–{st["losses"].get(i.id, 0)}</td></tr>' for i in hits[:200])
        return shell("My ideas", f'<p class="sub">Your Episteme library, read-only. Open an idea to see everything behind it, link it to a community entry, or rank it over another.</p>'
                     f'<form method="get" action="/ideas"><input name="q" value="{esc(q)}" placeholder="words in the claim, id or cluster" size="40"> <button>Find</button></form>'
                     f'<p class="sub">{len(hits)} of {len(ideas)}</p><table><tr><th>idea</th><th>stance</th><th>carries</th><th></th><th>over–under</th></tr>{rows}</table>', flash)

    def community_page(self, flash="") -> str:
        st = self.log.state()
        lastp = st["pulls"][-1] if st["pulls"] else {}
        comm = self.community()
        pull = self.form("/pull", f'Site <input name="url" value="{esc(lastp.get("url") or "")}" placeholder="https://claims.example" size="34" required> '
                                  f'issuer <input name="issuer" value="{esc(lastp.get("issuer") or "")}" placeholder="the issuer identifier, from somewhere other than that site" size="46" required> <button>Pull and verify</button>', "/community")
        body = f"<h2>Pull</h2><p>{pull}</p><p class='sub'>Downloads the site's export and runs the independent verifier on it here. Only entries it accepts can put pressure on your ideas.</p>"
        if comm:
            ideas = library.snapshot(root=self.args.root, branch=self.args.branch, db_path=getattr(self.args, "db_path", None)).ideas
            links = {}
            for (idea, entry), l in st["links"].items():
                links.setdefault(entry, []).append((idea, l["relation"]))
            def row(e):
                mine = "".join(f'<div><a href="/why?key={quote("idea:" + i)}">{esc(i)}</a> ({esc(rel)}) ' + self.form("/unlink", f'<input type="hidden" name="idea" value="{esc(i)}"><input type="hidden" name="entry" value="{esc(e.said)}"><button>Unlink</button>', "/community") + "</div>" for i, rel in links.get(e.said, []))
                link = self.form("/link", f'<input type="hidden" name="entry" value="{esc(e.said)}"><select name="relation"><option value="same">says what I hold in</option><option value="opposes">says the opposite of</option></select> '
                                          '<input name="idea" list="ideas" placeholder="idea id" required size="22"> <button>Link</button>', "/community") if e.ok else '<span class="warn">rejected by the verifier: ' + esc(next((n for n, ok, _ in e.checks if not ok), "?")) + "</span>"
                return (f'<tr><td>#{e.n} {esc(e.kind)}{" → #" + str(comm.by_said()[e.target].n) if e.target in comm.by_said() else ""}<div class="sub">{esc(e.handle)}</div></td>'
                        f'<td><a href="{esc(comm.url)}/entry/{esc(e.said)}" target="_blank" rel="noopener">{esc(e.text[:200])}</a><div class="sub"><a href="/why?key={quote("entry:" + e.said)}">verifier checks</a></div></td>'
                        f'<td>{esc(e.display or "—")}</td><td>{mine}{link}</td></tr>')
            body += (f'<h2>Entries</h2><p class="sub">{esc(comm.url)} · up to #{comm.head_n} · pulled {esc(lastp.get("at", "")[:16])} · '
                     + ('<span class="good">verified</span>' if comm.verified else f'<span class="warn">NOT verified: {esc("; ".join(comm.problems[:3]))}</span>')
                     + f'</p><table><tr><th></th><th>entry</th><th>stands at</th><th>my ideas</th></tr>{"".join(row(e) for e in comm.entries)}</table>{self.ideas_datalist(ideas)}')
        return shell("Community", body, flash)

    def pipeline_page(self, cand=None, result="", flash="") -> str:
        active = pl.active(self.log.state())
        p = cand or active
        def num(section, k, v):
            return f'<tr><td class="mono">{esc(k)}</td><td><input type="number" step="any" min="0" name="{section}.{k}" value="{v:g}"></td><td class="sub">{esc(pl.WHAT.get(k, ""))}{"" if active[section][k] == v else f" (active: {active[section][k]:g})"}</td></tr>'
        th = "".join(f'<tr><td class="mono">{esc(k)}</td><td><input name="thresholds.{k}" value="{esc(v)}" size="6"></td><td class="sub">{"" if active["thresholds"][k] == v else f"(active: {esc(active['thresholds'][k])})"}</td></tr>' for k, v in p["thresholds"].items())
        inner = (f'<h2>Points per rule <span class="sub">(0 switches a rule off)</span></h2><table>{"".join(num("signals", k, v) for k, v in p["signals"].items())}</table>'
                 f'<h2>Weight</h2><table>{"".join(num("weight", k, v) for k, v in p["weight"].items())}</table><h2>Thresholds</h2><table>{th}</table>'
                 f'<p>Items shown <input type="number" name="budget" min="1" value="{p["budget"]}"> · <label><input type="checkbox" name="outside_seat" {"checked" if p["outside_seat"] else ""}> keep one seat for the outside world</label></p>'
                 '<p><button name="do" value="try">Try on today\'s list</button> <button name="do" value="replay">Replay over my history</button> '
                 '&nbsp; note <input name="note" size="30" placeholder="why this change"> <button name="do" value="adopt">Adopt</button></p>')
        return shell("The rules and numbers", f'<p class="sub">score = weight × the points of the rules that fired. Active pipeline <span class="mono">{pl.digest(active)[:16]}…</span>'
                     + (f' · editing candidate <span class="mono">{pl.digest(p)[:16]}…</span>' if p != active else "") + ". Change numbers, try them, replay them against what you actually did, then adopt. Nothing changes until you adopt.</p>"
                     + result + self.form("/pipeline", inner, "/pipeline"), flash)

    def try_result(self, cand) -> str:
        d = au.diff_now(self.args, self.log, cand)
        (was, was_all), (new, new_all) = d["active"], d["candidate"]
        pw, pn = {i.key: n for n, i in enumerate(was, 1)}, {i.key: n for n, i in enumerate(new, 1)}
        rows = ""
        for key in list(pn) + [k for k in pw if k not in pn]:
            a, b = was_all.get(key), new_all.get(key)
            move = "NEW" if key not in pw else "OUT" if key not in pn else "same" if pw[key] == pn[key] else f"{pw[key]} → {pn[key]}"
            fa, fb = ({s.rule: s.points for s in (x.signals if x else []) if s.fired} for x in (a, b))
            changed = "; ".join(f"{r}: {fa.get(r, 0):g} → {fb.get(r, 0):g}" for r in sorted(set(fa) | set(fb)) if fa.get(r) != fb.get(r))
            rows += f'<tr><td>{move}</td><td><a href="/why?key={quote(key)}">{esc((b or a).title[:110])}</a></td><td>{a.score if a else 0:g} → {b.score if b else 0:g}</td><td class="sub">{esc(changed)}</td></tr>'
        return f'<h2>Today\'s list under these numbers</h2><table><tr><th>position</th><th>item</th><th>score</th><th>which rule moved it</th></tr>{rows}</table>'

    def replay_result(self, cand) -> str:
        r = au.replay(self.args, self.log, cand)
        if not r["lists"]:
            return "<h2>Replay</h2><p>No lists recorded yet. Use the list for a few days and respond to items; then there is a history to replay against.</p>"
        tally = "".join(f"<tr><td>{esc(k)}</td><td>{n}</td><td>{was}</td><td>{new}</td></tr>" for k, (n, was, new) in r["tally"].items())
        rows = "".join(f'<tr><td>{esc(x["at"][:16])}</td><td class="mono">{esc(", ".join(x["entered"]) or "—")}</td><td class="mono">{esc(", ".join(x["left"]) or "—")}</td><td class="mono">{esc(", ".join(f"{i} {resp}" for i, resp in x["you_then"]) or "—")}</td></tr>' for x in r["lists"])
        return ('<h2>Replayed over every list you were shown</h2><table><tr><th>what you then did</th><th>times</th><th>shown by the rules then in force</th><th>would be shown by these</th></tr>' + tally + '</table>'
                '<p class="sub">Better = keeps showing what you engaged with, stops showing what you dismissed. You only ever responded to what the old rules showed you, and a handful of responses proves nothing.</p>'
                f'<table><tr><th>list</th><th>would enter</th><th>would leave</th><th>you then</th></tr>{rows}</table>')

    def history(self, flash="") -> str:
        rows = "".join(f"<div class='item'><div class='sub'>{esc(r['at'][:16])} · pipeline <span class='mono'>{esc(r['pipeline'])}…</span> · library at event {r['library_sequence']} · "
                       + ("<b class='good'>reproduces</b>" if r["reproduces"] else f"<b class='warn'>does not reproduce</b> {esc(r.get('error', ''))}") + "</div><ol>"
                       + "".join(f"<li><a href='/why?key={quote(k)}'>{esc(k)}</a> <small>{sc:g}</small></li>" for k, sc in r.get("recorded", [])) + "</ol></div>" for r in reversed(au.audit(self.args, self.log)))
        pipes = "".join(f"<li>{esc(x['at'][:16])} <span class='mono'>{esc(x['digest'][:16])}…</span> {esc(x.get('note', ''))}</li>" for x in self.log.state()["pipelines"])
        return shell("Every list shown", "<p class='sub'>Each list is recomputed now from the coordinates recorded with it: pipeline, library position, community export, date.</p>"
                     + (rows or "<p>None yet.</p>") + (f"<h2>Pipelines adopted</h2><ul>{pipes}</ul>" if pipes else ""), flash)

    # ---- actions --------------------------------------------------------------------
    def candidate_from(self, f) -> dict:
        p = json.loads(json.dumps(pl.DEFAULT))
        for section in ("signals", "weight"):
            for k in p[section]:
                p[section][k] = float(f[f"{section}.{k}"])
        for k, v in p["thresholds"].items():
            raw = f[f"thresholds.{k}"]
            p["thresholds"][k] = raw if isinstance(v, str) else (int(raw) if isinstance(v, int) else float(raw))
        p["budget"], p["outside_seat"] = int(f["budget"]), "outside_seat" in f
        return pl.validate(p)

    def act(self, path, f):
        """Returns (page_html | None, redirect | None, flash)."""
        st = self.log.state()
        head_n = st["pulls"][-1]["head_n"] if st["pulls"] else 0
        if path == "/respond":
            data = {"item": f["item"], "response": f["response"], "head_n": head_n}
            if f["response"] not in ("engaged", "snoozed", "dismissed"):
                raise ValueError("unknown response")
            if f["response"] == "snoozed":
                data["until"] = (dt.date.today() + dt.timedelta(days=int(f.get("days") or 14))).isoformat()
            self.log.append("Responded", data)
            return None, f.get("back", "/"), ""
        if path in ("/link", "/unlink"):
            ids = {i.id for i in library.snapshot(root=self.args.root, branch=self.args.branch, db_path=getattr(self.args, "db_path", None)).ideas}
            if f["idea"] not in ids:
                raise ValueError(f"no idea '{f['idea']}' in your library")
            if path == "/link" and f["relation"] not in ("same", "opposes"):
                raise ValueError("relation must be same or opposes")
            self.log.append("Linked" if path == "/link" else "Unlinked", {"idea": f["idea"], "entry": f["entry"], **({"relation": f["relation"]} if path == "/link" else {})})
            return None, f.get("back", "/"), ""
        if path == "/over":
            ids = {i.id for i in library.snapshot(root=self.args.root, branch=self.args.branch, db_path=getattr(self.args, "db_path", None)).ideas}
            if f["under"] not in ids or f["over"] not in ids or f["under"] == f["over"]:
                raise ValueError("pick another idea of yours to rank it over")
            self.log.append("Compared", {"over": f["over"], "under": f["under"]})
            return None, f.get("back", "/"), ""
        if path == "/pull":
            comm, digest = com.pull(f["url"], f["issuer"], self.log.dir)
            self.log.append("CommunityPulled", {"url": comm.url, "issuer": f["issuer"], "digest": digest, "head_n": comm.head_n, "head": comm.head, "verified": comm.verified})
            return self.community_page(flash=("Verified: " if comm.verified else "NOT VERIFIED: ") + f"{len(comm.entries)} entries up to #{comm.head_n}"), None, ""
        if path == "/pipeline":
            cand = self.candidate_from(f)
            if f.get("do") == "adopt":
                self.log.append("PipelineAdopted", {"digest": pl.digest(cand), "pipeline": cand, "note": f.get("note", "")})
                return self.pipeline_page(flash=f"Adopted {pl.digest(cand)[:16]}…"), None, ""
            return self.pipeline_page(cand, self.try_result(cand) if f.get("do") == "try" else self.replay_result(cand)), None, ""
        raise LookupError(path)


def make_server(args, log):
    """(HTTPServer bound to 127.0.0.1, UI). Port 0 picks a free port (tests)."""
    ui = UI(args, log)
    allowed_hosts = set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def send(self, status, body="", location=None):
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def guarded(self, fn):
            if self.headers.get("Host") not in allowed_hosts:
                return self.send(403, shell("Refused", "<p>This page answers only to 127.0.0.1.</p>"))
            try:
                fn()
            except (LookupError, ValueError, KeyError) as ex:
                self.send(400, shell("That did not work", f"<p class='warn'>{esc(ex)}</p><p><a href='javascript:history.back()'>back</a></p>"))
            except Exception as ex:   # e.g. the community site is unreachable
                self.send(500, shell("That did not work", f"<p class='warn'>{esc(type(ex).__name__)}: {esc(ex)}</p><p><a href='/'>back to the list</a></p>"))

        def do_GET(self):
            def go():
                url = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                pages = {"/": ui.home, "/community": ui.community_page, "/pipeline": ui.pipeline_page, "/history": ui.history}
                if url.path == "/why":
                    return self.send(200, ui.why(q.get("key", "")))
                if url.path == "/ideas":
                    return self.send(200, ui.ideas(q.get("q", "")))
                if url.path in pages:
                    return self.send(200, pages[url.path]())
                self.send(404, shell("Not found", ""))
            self.guarded(go)

        def do_POST(self):
            def go():
                f = {k: v[0] for k, v in parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"), keep_blank_values=True).items()}
                if not secrets.compare_digest(f.get("token", ""), ui.token):
                    return self.send(403, shell("Refused", "<p>This form did not come from this page. Reload the page and try again.</p>"))
                page, redirect, _ = ui.act(urlparse(self.path).path, f)
                back = redirect if redirect and redirect.startswith("/") and not redirect.startswith("//") else "/"
                self.send(200, page) if page else self.send(303, location=back)
            self.guarded(go)

    httpd = HTTPServer(("127.0.0.1", args.port), Handler)
    port = httpd.server_address[1]
    allowed_hosts.update({f"127.0.0.1:{port}", f"localhost:{port}"})
    return httpd, ui


def serve(args, log) -> int:
    httpd, _ = make_server(args, log)
    print(f"focus: http://127.0.0.1:{httpd.server_address[1]}/  (this machine only)")
    httpd.serve_forever()
    return 0
