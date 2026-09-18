// The operator page. One static HTML document, no build step.
import { HANDLE_MAX } from "./handle";

export function operatorPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issuer operator</title>
<style>
  :root { color-scheme: light dark; --line: #8886; --ok: #1a7f37; --bad: #b3261e; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .sub { opacity: .7; margin-top: .2rem; }
  fieldset { border: 1px solid var(--line); border-radius: .5rem; display: grid; grid-template-columns: minmax(0, 24rem); gap: .75rem; padding: 1rem; }
  label { display: flex; flex-direction: column; font-size: .85rem; gap: .25rem; }
  input { font: inherit; padding: .4rem; } button { font: inherit; padding: .6rem 1.2rem; margin-top: 1rem; cursor: pointer; }
  code, .mono { font-family: ui-monospace, monospace; font-size: .8rem; word-break: break-all; }
  #qr svg, #onboardQr svg { width: min(100%, 20rem); height: auto; background: #fff; padding: .5rem; border-radius: .5rem; }
  .state { font-weight: 600; } .ok { color: var(--ok); } .bad { color: var(--bad); }
  table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: .35rem .5rem; text-align: left; vertical-align: top; }
  details { margin-top: .5rem; } .warn { border-left: 4px solid var(--bad); padding: .25rem .75rem; }
</style>
</head>
<body>
<h1>Issuer operator</h1>
<p class="sub">Issue one community membership credential to the phone in front of you.</p>

<details id="onboard">
  <summary>First time with this wallet? Onboarding QR</summary>
  <p class="sub">A new wallet must be connected to this backend once. In the app, on "Connect to Veridian", tap <b>Proceed to scan</b> and scan this. (Advanced setup: boot URL <span id="bootUrl" class="mono"></span>.)</p>
  <div id="onboardQr"></div>
</details>

<h2>1. Enter the member's handle</h2>
<p class="sub">The name the member is shown under. It is the only thing the credential says about them besides their identifier.</p>
<form id="form">
  <fieldset>
        <label>handle<input type="text" name="handle" maxlength="${HANDLE_MAX}" required autocomplete="off"></label>
  </fieldset>
  <button type="submit">Create QR code</button>
  <span id="formError" class="bad"></span>
</form>

<section id="sessionBox" hidden>
  <h2>2. Have the holder scan this with the wallet</h2>
  <p class="warn">Whoever scans this code first receives the credential. Show it only to the intended person. It expires and works once.</p>
  <div id="qr"></div>
  <p>Status: <span id="state" class="state"></span></p>
  <table id="detail"></table>
</section>

<h2>Members</h2>
<p class="sub">Every membership credential issued here. Revoking first anchors the relying party's current log head in this issuer's event log (a checkpoint), so that what the member signed before stays verifiable; it refuses if the log cannot be reached.</p>
<p><button type="button" id="checkpoint">Checkpoint the log now</button> <span id="memberMsg"></span></p>
<table id="members"></table>

<h2>This issuer</h2>
<table id="issuer"></table>
<details>
  <summary>Inception event and witness receipts</summary>
  <p class="sub">The first event in this issuer's log, the issuer's own signature on it, and one receipt from each witness that has seen it. These witnesses are the containers running on this machine. There is no ledger behind them.</p>
  <table id="inception"></table>
  <pre class="mono" id="inceptionEvent"></pre>
</details>

<script>
const $ = (id) => document.getElementById(id);
const row = (k, v) => "<tr><th>" + k + "</th><td class='mono'>" + v + "</td></tr>";
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const WORDS = {
  "waiting-for-scan": "Waiting for the phone to scan",
  "issuing": "Phone connected. Issuing",
  "granted": "Sent. Waiting for the holder to accept it in the wallet",
  "admitted": "Accepted. The credential is in the wallet",
  "expired": "Expired before anyone scanned it",
  "failed": "Failed",
};

async function loadIssuer() {
  const i = await (await fetch("/api/issuer")).json();
  if (i.walletQrSvg) { $("onboardQr").innerHTML = i.walletQrSvg; $("bootUrl").textContent = i.walletBootUrl; } else { $("onboard").hidden = true; }
  $("issuer").innerHTML = row("Identifier (AID)", i.aid) + row("Events so far", i.sn + 1) +
    row("Witnesses", i.witnesses.length + " (needs " + i.threshold + " to agree)") +
    row("Next key, already committed", i.nextKeyDigests.join("<br>")) +
    row("Registry", i.registry) + row("Schema", i.schema);
  const e = await (await fetch("/api/issuer/inception")).json();
  $("inception").innerHTML = row("Issuer signatures", e.controllerSignatures) + row("Witness receipts", e.witnessReceipts) +
    row("Witnesses named in the event", (e.event.b || []).join("<br>"));
  $("inceptionEvent").textContent = JSON.stringify(e.event, null, 2);
}

let timer;
function show(s) {
  $("sessionBox").hidden = false;
  $("qr").innerHTML = s.qrSvg || "";
  const done = s.state === "admitted", bad = s.state === "failed" || s.state === "expired";
  $("state").textContent = WORDS[s.state] || s.state;
  $("state").className = "state " + (done ? "ok" : bad ? "bad" : "");
  $("detail").innerHTML = row("Handle", esc(s.handle)) + (s.holderAlias ? row("Wallet name", esc(s.holderAlias)) : "") +
    (s.holderAid ? row("Holder AID", s.holderAid) : "") +
    (s.credentialSaid ? row("Credential", s.credentialSaid) : "") +
    (s.error ? row("Error", esc(s.error)) : "");
  if (done || bad) { clearInterval(timer); loadMembers(); }
}

function say(text, bad) { $("memberMsg").textContent = text; $("memberMsg").className = bad ? "bad" : "ok"; }
async function loadMembers() {
  const members = await (await fetch("/api/members")).json();
  $("members").innerHTML = "<tr><th>Handle</th><th>Member AID</th><th>Credential</th><th>Status</th><th></th></tr>" +
    members.map((m) => "<tr><td>" + esc(m.handle) + "</td><td class='mono'>" + esc(m.memberAid) + "</td><td class='mono'><a href='/registry/" + esc(m.said) + ".cesr'>" + esc(m.said) + "</a></td><td>" +
      (m.status === "rev" ? "<span class='bad'>revoked</span>" : "valid") + "</td><td>" +
      (m.status === "rev" ? "" : "<button type='button' data-revoke='" + esc(m.said) + "'>Revoke</button>") + "</td></tr>").join("");
}
$("members").addEventListener("click", async (ev) => {
  const said = ev.target.dataset && ev.target.dataset.revoke;
  if (!said || !confirm("Revoke " + said + "? This cannot be undone.")) return;
  say("Checkpointing the log, then revoking\u2026");
  let res = await fetch("/api/members/" + said + "/revoke", { method: "POST" });
  let out = await res.json();
  if (res.status === 502 && confirm(out.error + "\n\nRevoke WITHOUT a checkpoint anyway?")) {
    res = await fetch("/api/members/" + said + "/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ noCheckpoint: true }) });
    out = await res.json();
  }
  say(res.ok ? "Revoked at issuer event " + out.revocationSn + (out.checkpointSn === undefined ? " (NO checkpoint)" : ", checkpoint at event " + out.checkpointSn) : out.error, !res.ok);
  loadMembers(); loadIssuer();
});
$("checkpoint").addEventListener("click", async () => {
  say("Checkpointing\u2026");
  const res = await fetch("/api/checkpoint", { method: "POST" });
  const out = await res.json();
  say(res.ok ? "Log head " + out.head.d + " (entry " + out.head.n + ") anchored at issuer event " + out.sn : out.error, !res.ok);
  loadIssuer();
});

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("formError").textContent = "";
  const handle = new FormData(ev.target).get("handle");
  const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle }) });
  const s = await res.json();
  if (!res.ok) { $("formError").textContent = s.error; return; }
  show(s);
  clearInterval(timer);
  timer = setInterval(async () => show(await (await fetch("/api/sessions/" + s.id)).json()), 1500);
});
loadIssuer();
loadMembers();
</script>
</body>
</html>`;
}
