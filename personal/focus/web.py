"""The focus list as one server-rendered page. Binds to 127.0.0.1 only: it shows private ideas."""
import datetime as dt
import html
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

from urllib.parse import quote, urlparse

from . import audit as au, pipeline as pl, trace

STYLE = """
:root{color-scheme:light dark;--line:#8886;--bad:#b3261e;--ok:#1a7f37}
body{font:16px/1.5 system-ui,sans-serif;max-width:50rem;margin:0 auto;padding:1rem}
h1{font-size:1.4rem;margin-bottom:0}.sub{opacity:.75;font-size:.9rem}
.item{border:1px solid var(--line);border-radius:.5rem;padding:.8rem 1rem;margin:1rem 0}
.item h2{font-size:1.05rem;margin:0 0 .2rem}.score{float:right;font-weight:600;font-variant-numeric:tabular-nums}
ul{margin:.4rem 0;padding-left:1.2rem}li small{opacity:.7}
a,button{color:inherit}button{font:inherit;padding:.25rem .7rem;border:1px solid var(--line);border-radius:.4rem;background:none;cursor:pointer}
form{display:inline}.mono{font-family:ui-monospace,monospace;font-size:.8rem}.warn{color:var(--bad)}
"""
esc = lambda s: html.escape(str(s), quote=True)


def page(items, comm) -> str:
    def move(label, target):
        if target.startswith("http"):
            return f'<li><a href="{esc(target)}" target="_blank" rel="noopener">{esc(label)}</a></li>'
        return f'<li>{esc(label)}: <span class="mono">{esc(target)}</span></li>'

    def item(it):
        buttons = "".join(f'<form method="post" action="/respond"><input type="hidden" name="item" value="{esc(it.key)}">'
                          f'<button name="response" value="{v}">{label}</button></form> '
                          for v, label in (("engaged", "I looked at it"), ("snoozed", "Not now (14 days)"), ("dismissed", "Not important")))
        return (f'<div class="item"><span class="score" title="weight {it.weight} × signals">{it.score:g}</span><h2>{esc(it.title)}</h2>'
                f'<div class="sub">{esc(it.detail)} · weight {it.weight:g} · <a href="/why?key={quote(it.key)}">how this got here</a></div>'
                f'<ul>{"".join(f"<li>{esc(why)} <small>+{p:g}</small></li>" for p, why in it.reasons)}</ul>'
                f'<div class="sub">What you could do</div><ul>{"".join(move(l, t) for l, t in it.moves if not t.startswith("focus "))}</ul>{buttons}</div>')

    if comm is None:
        head = '<p class="warn">No community pulled yet: <span class="mono">python -m focus pull URL --issuer AID</span></p>'
    else:
        head = (f'<p class="sub">Community: <a href="{esc(comm.url)}">{esc(comm.url)}</a>, {len(comm.entries)} entries up to #{comm.head_n}, '
                + ('independently verified' if comm.verified else f'<span class="warn">NOT verified: {esc("; ".join(comm.problems[:3]))}</span>') + '</p>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>Focus</title><style>{STYLE}</style></head><body><h1>What deserves your attention</h1>'
            f'<p class="sub">From your own library and the community log. Each item says why it is here; the number is weight × the points shown. '
            f'This page is served on this machine only. <a href="/pipeline">the rules and numbers</a> · <a href="/history">every list shown, and whether it still reproduces</a></p>{head}'
            f'{"".join(item(i) for i in items) or "<p>Nothing is pressing. Go learn something new.</p>"}</body></html>')


def why_page(t) -> str:
    rules = "".join(f'<tr class="{"on" if s["fired"] else "off"}"><td>{"●" if s["fired"] else "○"}</td><td class="mono">{esc(s["rule"])}</td><td>{("+" + format(s["points"], "g")) if s["fired"] else ""}</td>'
                    f'<td>{esc(s["text"])}<div class="sub">rule: {esc(s["what"])}</div>'
                    + (f'<div class="sub mono">looked at: {esc(", ".join(f"{k}={v}" for k, v in s["inputs"].items()))}</div>' if s["inputs"] else "") + "</td></tr>" for s in t["signals"])
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>How this got here</title>'
            f'<style>{STYLE} table{{border-collapse:collapse;width:100%}} td{{padding:.3rem .5rem;vertical-align:top;border-bottom:1px solid var(--line)}} tr.off{{opacity:.55}} pre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head><body>'
            f'<p class="sub"><a href="/">← the list</a></p><h1>{esc(t["title"])}</h1><p class="sub">{esc(t["detail"])}</p>'
            f'<h2>Every rule, fired or not</h2><table>{rules}</table>'
            f'<h2>The whole derivation</h2><pre class="mono">{esc(trace.text(t))}</pre></body></html>')


def simple_page(title, body) -> str:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{esc(title)}</title><style>{STYLE} pre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head>'
            f'<body><p class="sub"><a href="/">← the list</a></p><h1>{esc(title)}</h1>{body}</body></html>')


def serve(args, log) -> int:

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/why":
                top, everything, snap, comm, p = au.produce(args, log, record=False)
                try:
                    out = why_page(trace.build(parse_qs(url.query).get("key", [""])[0], everything, top, snap, comm, log.state(), p, log))
                except LookupError as ex:
                    out = simple_page("Not found", f"<p>{esc(ex)}</p>")
            elif url.path == "/pipeline":
                p = pl.active(log.state())
                rules = "".join(f"<li><span class='mono'>{esc(k)}</span> = {v:g}: {esc(pl.WHAT.get(k, ''))}</li>" for k, v in p["signals"].items())
                out = simple_page("The rules and numbers", f"<p class='sub'>score = weight × the points of the rules that fired. Pipeline <span class='mono'>{pl.digest(p)[:16]}…</span>. "
                                  f"Edit a copy and test it before adopting: <span class='mono'>python -m focus pipeline &gt; my.json; python -m focus try my.json; python -m focus replay my.json; python -m focus adopt my.json</span></p>"
                                  f"<ul>{rules}</ul><pre class='mono'>{esc(__import__('json').dumps(p, indent=2))}</pre>")
            elif url.path == "/history":
                rows = "".join(f"<div class='item'><div class='sub'>{esc(r['at'][:16])} · pipeline <span class='mono'>{esc(r['pipeline'])}…</span> · library at event {r['library_sequence']} · "
                               + ("<b>reproduces</b>" if r["reproduces"] else f"<b class='warn'>does not reproduce</b> {esc(r.get('error', ''))}") + "</div><ol>"
                               + "".join(f"<li><a href='/why?key={quote(k)}'>{esc(k)}</a> <small>{sc:g}</small></li>" for k, sc in r.get("recorded", [])) + "</ol></div>" for r in reversed(au.audit(args, log)))
                out = simple_page("Every list shown", "<p class='sub'>Each list is recomputed now from the coordinates recorded with it (pipeline, library position, community export, date).</p>" + (rows or "<p>None yet.</p>"))
            else:
                top, _, _, comm, _ = au.produce(args, log)
                out = page(top, comm)
            body = out.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
            item, response = form.get("item", [""])[0], form.get("response", [""])[0]
            if self.path == "/respond" and item and response in ("engaged", "snoozed", "dismissed"):
                st = log.state()
                data = {"item": item, "response": response, "head_n": st["pulls"][-1]["head_n"] if st["pulls"] else 0}
                if response == "snoozed":
                    data["until"] = (dt.date.today() + dt.timedelta(days=14)).isoformat()
                log.append("Responded", data)
            self.send_response(303)
            self.send_header("Location", "/")
            self.end_headers()

    print(f"focus: http://127.0.0.1:{args.port}/  (this machine only)")
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    return 0
