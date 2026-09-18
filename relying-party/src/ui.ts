// Server-rendered pages, no build step, no framework. The only script is
// the session page's status poll, as in demo2.
import { Q, aggregate } from "@pilot/common/src/dfquad";
import type { Decision } from "./gate";
import type { Node, View } from "./projection";

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const short = (s: string) => `${s.slice(0, 10)}…`;

const STYLE = `
  :root { color-scheme: light dark; --line: #8886; --ok: #1a7f37; --bad: #b3261e; --sup: #1a7f37; --att: #b3261e; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .sub { opacity: .75; margin-top: .2rem; font-size: .9rem; }
  .mono { font-family: ui-monospace, monospace; font-size: .8rem; word-break: break-all; }
  #qr svg { width: min(100%, 18rem); height: auto; background: #fff; padding: .5rem; border-radius: .5rem; }
  .state { font-weight: 600; } .ok { color: var(--ok); } .bad { color: var(--bad); }
  ul.chain { list-style: none; padding: 0; } ul.chain li { padding: .3rem 0; border-bottom: 1px solid var(--line); }
  ul.chain li::before { content: "✓ "; color: var(--ok); } ul.chain li.bad::before { content: "✗ "; color: var(--bad); } ul.chain li.nc::before { content: "– "; }
  ul.chain small { display: block; opacity: .75; }
  textarea { width: 100%; font: inherit; padding: .5rem; box-sizing: border-box; }
  button, .btn { font: inherit; padding: .35rem .8rem; cursor: pointer; border: 1px solid var(--line); border-radius: .4rem; text-decoration: none; display: inline-block; background: none; color: inherit; }
  .entry { border: 1px solid var(--line); border-left-width: .3rem; border-radius: .5rem; padding: .7rem 1rem; margin: .7rem 0; }
  .entry.attack { border-left-color: var(--att); } .entry.support { border-left-color: var(--sup); } .entry.out { opacity: .6; }
  .entry blockquote { margin: 0 0 .3rem; font-size: 1.05rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .strength { float: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 1.2rem; margin-left: 1rem; }
  .kids { margin-left: 1rem; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } a { color: inherit; }
  table.sum { border-collapse: collapse; } table.sum td { padding: .15rem .6rem .15rem 0; vertical-align: top; }
`;

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

function entryHtml(n: Node): string {
  const p = n.record.payload;
  const label = p.kind === "claim" ? "claims" : p.kind === "attack" ? "attacks this" : "supports this";
  const kids = [...n.supporters, ...n.attackers, ...n.inert.map((i) => i.node)].sort((a, b) => a.record.n - b.record.n);
  const why = n.excluded ?? (n.result && !n.result.counted ? "does not count toward its target: the same member already made this move there" : "");
  return `<div class="entry ${esc(p.kind)} ${why ? "out" : ""}" id="${esc(n.record.d)}">
    ${n.result ? `<span class="strength" title="exactly ${esc(n.result.strength)}">${esc(n.result.display)}</span>` : `<span class="strength" title="not an argument">–</span>`}
    <blockquote>${esc(p.text)}</blockquote>
    <div class="sub"><b>${esc(n.handle)}</b> ${label} · entry ${n.record.n}${why ? ` · <span class="bad">${esc(why)}</span>` : ""}</div>
    <div class="sub"><a href="/entry/${esc(n.record.d)}">signed entry, and how the number was computed</a> ·
      <a class="btn" href="/start?kind=support&amp;target=${esc(n.record.d)}">Support</a>
      <a class="btn" href="/start?kind=attack&amp;target=${esc(n.record.d)}">Attack</a></div>
    ${kids.length ? `<div class="kids">${kids.map(entryHtml).join("")}</div>` : ""}
  </div>`;
}

export function graphPage(view: View, operatorAid: string, community: string): string {
  const claims = view.nodes.filter((n) => n.record.payload.kind === "claim").reverse();
  const s = view.genesis?.payload.semantics;
  return page(community, `
<h1>${esc(community)}</h1>
<p class="sub">One shared argument. Every entry was signed on its author's own phone; nobody logged in, and this site has no user table. An attack never deletes or hides anything: it is a signed entry of its own, and it moves a number.</p>
<p><a class="btn" href="/start?kind=claim">Post a claim</a> <a class="btn" href="/verify">Check all of this yourself</a></p>
${claims.map(entryHtml).join("") || "<p class='sub'>No claims yet.</p>"}
<h2>How the numbers are computed</h2>
<p class="sub">Every entry starts at ${esc(s?.base_score)}. Supporters pull it toward 1, attackers toward 0, each in proportion to its own current number (DF-QuAD; the exact rules are in SEMANTICS.md and are declared in <a href="/entry/${esc(view.genesis?.d)}.json">the log's first record</a>, not in this site's code). Numbers are exact fractions; the decimals shown are rounded to ${esc(s?.display.decimals)} places.</p>
<p class="sub">Log operator <span class="mono">${esc(operatorAid)}</span> · issuer's key event log seen up to event ${view.issuerSeen} · <a href="/log.json">raw log</a> · <a href="/decisions">every gate decision</a></p>`);
}

/** Lesson 2: the arithmetic that produced this number, from the declared parameters, the way one would do it on paper. */
function arithmetic(n: Node, tau: string): string {
  if (!n.result) return `<p>This entry is not an argument: ${esc(n.excluded)}. It has no number and moves no other number.</p>`;
  const side = (nodes: Node[], word: string) => {
    if (nodes.length === 0) return { html: `<tr><td>${word}</td><td>none, so their combined pull is 0</td></tr>`, v: Q.ZERO };
    const qs = nodes.map((k) => Q.parse(k.result!.strength)!);
    const v = aggregate(qs);
    return { v, html: `<tr><td>${word}</td><td>${nodes.map((k) => `<a href="/entry/${esc(k.record.d)}">entry ${k.record.n}</a> at ${esc(k.result!.strength)}`).join(", ")}<br>
      combined pull = 1 − ${qs.map((q) => `(1 − ${q})`).join(" × ")} = <b>${v}</b></td></tr>` };
  };
  const att = side(n.attackers, "Attackers"), sup = side(n.supporters, "Supporters");
  const t = Q.parse(tau)!;
  const c = att.v.cmp(sup.v);
  const line = c === 0 ? `attack and support pull equally, so the number stays at the starting value ${t}`
    : c > 0 ? `attack is stronger by ${att.v.sub(sup.v)}: ${t} − ${t} × ${att.v.sub(sup.v)} = <b>${n.result.strength}</b>`
    : `support is stronger by ${sup.v.sub(att.v)}: ${t} + (1 − ${t}) × ${sup.v.sub(att.v)} = <b>${n.result.strength}</b>`;
  return `<table class="sum"><tr><td>Starts at</td><td>${t} (declared in the log's first record)</td></tr>${att.html}${sup.html}
    <tr><td>Result</td><td>${line}${n.result.strength.length < 40 ? ` ≈ ${esc(n.result.display)}` : ""}</td></tr></table>
    ${n.inert.length ? `<p class="sub">Not counted: ${n.inert.map((i) => `entry ${i.node.record.n} (${esc(i.why)})`).join("; ")}.</p>` : ""}`;
}

export function entryPage(n: Node, view: View, decision: Decision | undefined): string {
  const r = n.record, p = r.payload;
  return page(`Entry ${r.n}`, `
<p class="sub"><a href="/#${esc(r.d)}">← the argument</a></p>
<h1>Entry ${r.n}: ${esc(n.handle)} ${p.kind === "claim" ? "claims" : p.kind + "s " + (view.byId.get(p.target!) ? `entry ${view.byId.get(p.target!)!.record.n}` : "")}</h1>
<div class="entry ${esc(p.kind)}"><blockquote>${esc(p.text)}</blockquote></div>

<h2>The number, by hand</h2>${arithmetic(n, view.genesis!.payload.semantics.base_score)}

<h2>Who said this</h2>
<p>Not an account: an identifier, <span class="mono">${esc(p.author)}</span>, which is derived from the first event of <a href="/kel/${esc(p.author)}">its own key event log</a>. The keys are on the author's phone. "${esc(n.handle)}" is the handle in the membership credential <span class="mono">${esc(p.credential)}</span> the community issuer gave that identifier.</p>
<h2>What the phone showed and the author approved</h2><pre class="mono">${esc(JSON.stringify(p, null, 2))}</pre>
<p class="sub">Its first line, <span class="mono">d</span>, is the digest of the rest. Change one character of the text and the digest no longer matches.</p>
<h2>The signature</h2>
<p>The author's phone did not sign the text directly. It added event ${parseInt(r.anchor.s, 16)} to the author's key event log, and that event contains the digest above. The event is signed with the author's current key and receipted by the witnesses.</p>
<pre class="mono">${esc(JSON.stringify(r.anchor.ked, null, 2))}</pre>
<p><b>Signatures and witness receipts on that event</b></p><pre class="mono">${esc(r.anchor.atc)}</pre>
<h2>What this site's gate checked before writing it</h2>
${decision ? `<ul class="chain">${decision.checks.map((c) => `<li class="${c.ok ? "" : "bad"}">${esc(c.check)}<small>${esc(c.detail)} — ${esc(c.verifiedBy)}</small></li>`).join("")}</ul>` : "<p class='sub'>No decision on file.</p>"}
<p class="sub">Raw record: <a href="/entry/${esc(r.d)}.json">/entry/${esc(short(r.d))}.json</a> · previous record <span class="mono">${esc(r.p)}</span></p>`);
}

export function kelPage(aid: string, events: Array<{ ked: any; atc: string }>): string {
  return page("Key event log", `
<p class="sub"><a href="/">← the argument</a></p><h1>Key event log</h1><p class="mono">${esc(aid)}</p>
<p class="sub">Event 0 creates the identifier and names its first key, the digest of its next key, and its witnesses. Every later event is signed by the key the log itself establishes and receipted by the witnesses. This copy is what this site's KERIA agent holds; the witnesses serve the same log to anyone.</p>
${events.map((e) => `<h2>Event ${parseInt(e.ked.s, 16)} (${esc(e.ked.t)})</h2><pre class="mono">${esc(JSON.stringify(e.ked, null, 2))}</pre><pre class="mono">${esc(e.atc)}</pre>`).join("")}`);
}

export function verifyPage(issuerAid: string, publicUrl: string): string {
  return page("Check it yourself", `
<p class="sub"><a href="/">← the argument</a></p><h1>You do not have to trust this site</h1>
<p>Download everything: <a href="/export.json">/export.json</a>. It holds the log, the key event logs of everyone who wrote in it, and the issuer's membership records. Then, on a computer that has never talked to this site's application:</p>
<pre class="mono">git clone &lt;this repository&gt; &amp;&amp; cd &lt;it&gt;/verifier
python3.12 -m venv .venv &amp;&amp; . .venv/bin/activate &amp;&amp; pip install -r requirements.txt
curl -o export.json ${esc(publicUrl)}/export.json
python -m arglog_verifier export.json --issuer ${esc(issuerAid)}</pre>
<p>The program is a separate implementation in a different language (Python on keripy; this site is TypeScript on KERIA). It re-checks every signature against each author's key event log, counts witness receipts against each author's threshold, re-checks every membership and its revocation, and recomputes every number. The report should match this site entry for entry.</p>
<p>Then open export.json, change one letter of one entry's text, and run it again.</p>
<p class="sub">The issuer identifier above is the one thing to get from somewhere other than this site.</p>`);
}

export function decisionsPage(decisions: Decision[]): string {
  return page("Gate decisions", `
<p class="sub"><a href="/">← the argument</a></p><h1>Every gate decision</h1>
<p class="sub">Accepted and rejected, newest first. A rejected entry is never written to the log.</p>
${[...decisions].reverse().map((d) => `<div class="entry ${d.decision === "accept" ? "support" : "attack"}">
  <div><b class="${d.decision === "accept" ? "ok" : "bad"}">${esc(d.decision)}</b>${d.failed ? ` at check <b>${esc(d.failed)}</b>` : ""} · ${esc(d.kind)} · ${esc(d.dt)}</div>
  <div class="sub mono">author ${esc(d.author)} · payload ${esc(d.payload)}${d.record ? ` · <a href="/entry/${esc(d.record)}">record</a>` : ""}</div>
  <ul class="chain">${d.checks.map((c) => `<li class="${c.ok ? "" : "bad"}">${esc(c.check)}<small>${esc(c.detail)} — ${esc(c.verifiedBy)}</small></li>`).join("")}</ul></div>`).join("") || "<p class='sub'>None yet.</p>"}`);
}

export function sessionPage(id: string, kind: string, target: Node | undefined, maxLen: number, prefill = ""): string {
  const verb = kind === "claim" ? "Post a claim" : kind === "attack" ? "Attack an entry" : "Support an entry";
  return page(verb, `
<h1>${esc(verb)}</h1><p class="sub"><a href="/">← the argument</a></p>
${target ? `<div class="entry ${esc(target.record.payload.kind)}"><blockquote>${esc(target.record.payload.text)}</blockquote><div class="sub">${esc(target.handle)} · entry ${target.record.n}</div></div>` : ""}
<section id="scan"><h2>1. Scan with your wallet</h2>
<p>In the wallet: Home → Add connection → Scan. The first time, the wallet then asks you to share your membership credential. After that it will not ask again.</p><div id="qr"></div></section>
<p>Status: <span id="state" class="state"></span></p><ul id="chain" class="chain"></ul>
<section id="box" hidden><h2>2. Write it</h2>
<p>${kind === "claim" ? "Your claim" : kind === "attack" ? "Why is the entry above wrong?" : "Why is the entry above right?"} Your phone will show you this text and ask you to sign. The phone shows only the beginning of a long text; what you sign is the whole text as you see it here.</p>
<textarea id="text" rows="4" maxlength="${maxLen}">${esc(prefill)}</textarea>
<p><button id="send">Send to my phone to sign</button> <span id="err" class="bad"></span></p></section>
<section id="result"></section>
<script>
const $ = (i) => document.getElementById(i);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const WORDS = { "waiting-for-scan": "Waiting for your phone to scan", "requesting": "Connected. Your wallet is asking you to share your membership credential",
  "verifying": "Checking the credential", "verified": "You are a member", "awaiting-signature": "Check your phone: open the signing request and tap Sign",
  "rejected": "Rejected", "expired": "This session expired. Start again." };
let timer;
function render(s) {
  if (s.qrSvg) $("qr").innerHTML = s.qrSvg;
  $("scan").hidden = s.state !== "waiting-for-scan";
  const bad = ["rejected", "expired"].includes(s.state);
  $("state").textContent = (WORDS[s.state] || s.state) + (s.handle ? " (" + s.handle + ")" : "") + (s.rejection ? ": " + s.rejection : "");
  $("state").className = "state " + (bad ? "bad" : ["verified", "awaiting-signature"].includes(s.state) ? "ok" : "");
  $("chain").innerHTML = (s.chain || []).map((c) => "<li class='" + (c.ok === false ? "bad" : c.ok === null ? "nc" : "") + "'>" + esc(c.check) + "<small>" + esc(c.detail) + "</small></li>").join("");
  $("box").hidden = s.state !== "verified";
  if (s.last) $("result").innerHTML = s.last.decision === "accept"
    ? "<h2>Written to the log</h2><p><a href='/entry/" + esc(s.last.record) + "'>See your signed entry</a> · <a href='/'>the argument</a></p>"
    : "<h2 class='bad'>Not written</h2><p>The gate stopped at the check <b>" + esc(s.last.failed) + "</b>: " + esc((s.last.checks[s.last.checks.length - 1] || {}).detail) + "</p>";
  if (bad) clearInterval(timer);
}
async function poll() { render(await (await fetch("/api/sessions/${id}")).json()); }
$("send").addEventListener("click", async () => {
  $("err").textContent = ""; $("result").innerHTML = "";
  const res = await fetch("/api/sessions/${id}/entry", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: ${JSON.stringify(kind)}, target: ${JSON.stringify(target?.record.d ?? null)}, text: $("text").value }) });
  const s = await res.json();
  if (!res.ok) { $("err").textContent = s.error; return; }
  $("text").value = ""; render(s);
});
poll(); timer = setInterval(poll, 1500);
</script>`);
}
