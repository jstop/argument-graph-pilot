// End to end against the LIVE compose stack (infra/stack.sh up): real
// KERIA, real witnesses, the real issuer and relying-party classes behind
// their real HTTP servers, Signify clients standing in for the phones.
// No fake signer, no mocked KEL: every rejected entry below was really
// signed by a real identifier, and rejected anyway.
//
// Runs the success criterion, one rejection per gate check, revocation,
// and then hands the export to the independent Python verifier and
// compares every number.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { entryPayload } from "@pilot/common/src/log";
import { WalletStandIn } from "@pilot/common/src/testing/wallet-standin";
import { Issuer } from "../../issuer/src/core";
import { buildServer as buildIssuerServer } from "../../issuer/src/server";
import { RelyingParty } from "../src/core";
import { Gate } from "../src/gate";
import { buildServer } from "../src/server";

const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
const IPORT = 3941, RPORT = 3942;
const HOST = process.env.TEST_PUBLIC_HOST ?? "host.docker.internal"; // how KERIA (in a container) reaches this process
const RP = `http://127.0.0.1:${RPORT}`;
const SCHEMA_DIR = join(__dirname, "../../schema");
const SCHEMA_SAID = readFileSync(join(SCHEMA_DIR, "SAID"), "utf8").trim();
const PYTHON = process.env.VERIFIER_PYTHON ?? "python3";
const NON_ASCII = "Tap water here is safe to drink — naïve? 日本語 ✓ 🎉";

let issuer: Issuer, rp: RelyingParty, servers: Server[] = [], rpDir: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getJson = async (path: string) => (await fetch(`${RP}${path}`)).json();

async function until<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await issuer.tick(); await rp.tick();
    const got = await probe();
    if (got) return got;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function enrol(handle: string, from: Issuer = issuer): Promise<{ wallet: WalletStandIn; said: string; handle: string }> {
  const wallet = await WalletStandIn.create(KERIA, handle);
  const session = from.createSession(handle);
  await wallet.scan(from.qrUrl(session));
  await until("grant", () => from.session(session.id)?.state === "granted");
  return { wallet, handle, said: await wallet.acceptCredential(from.oobi) };
}

/** A browser session as a member drives it: /start, scan, present if asked. Returns the session id. */
async function openSession(m: { wallet: WalletStandIn; said: string }, query: string, expectPresentation: boolean, present = true): Promise<string> {
  const start = await fetch(`${RP}/start?${query}`, { redirect: "manual" });
  assert.equal(start.status, 303);
  const id = start.headers.get("location")!.split("/s/")[1].split("?")[0];
  const s = await getJson(`/api/sessions/${id}`);
  await m.wallet.scan(s.qrUrl);
  const state = await until("scan seen", async () => { const x = rp.session(id)!; return x.state !== "waiting-for-scan" && x.state; });
  assert.equal(state === "requesting", expectPresentation, `session went to ${state}`);
  if (expectPresentation && present) await presentIn(id, m);
  return id;
}

async function presentIn(id: string, m: { wallet: WalletStandIn; said: string }): Promise<void> {
  {
    const presenting = m.wallet.present(m.said);
    await until("presentation verdict", () => ["verified", "rejected"].includes(rp.session(id)!.state));
    await presenting;
  }
}

async function post(id: string, m: { wallet: WalletStandIn }, kind: string, text: string, target?: string, sign: { approve: boolean; lieAboutSn?: string } = { approve: true }) {
  const res = await fetch(`${RP}/api/sessions/${id}/entry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, text, target }) });
  assert.equal(res.status, 200, await res.clone().text());
  const shown = await m.wallet.handleSignRequest(sign);
  if (!sign.approve) return { shown, decision: undefined };
  const s = await until("gate decision", () => rp.session(id)!.last && rp.session(id)!);
  return { shown, decision: s.last! };
}

/** Really signed, by a real identifier, but handed to the gate without the web flow: for payloads the web flow would never build. */
async function signedDirect(m: { wallet: WalletStandIn }, payload: any): Promise<string> {
  const client = (rp as any).client;
  const hab = await client.identifiers().get("log");
  const [req, sigs, atc] = await client.exchanges().createExchangeMessage(hab, "/remotesign/ixn/req", payload, {}, m.wallet.aid);
  await client.exchanges().sendFromEvents("log", "remotesign", req, sigs, atc, [m.wallet.aid]);
  assert.ok((await m.wallet.handleSignRequest({ approve: true })).accepted);
  const hab2 = await m.wallet.client.identifiers().get("holder");
  return hab2.state.s as string;
}

const strengths = async () => Object.fromEntries(((await getJson("/api/strengths")) as any[]).map((r) => [r.said, r]));

let alice: Awaited<ReturnType<typeof enrol>>, bob: typeof alice, rex: typeof alice, mallory: typeof alice;
let claim = "", aliceSession = "", rexSession = "", mallorySession = "";

before(async () => {
  const token = "test-operator-token-0123456789"; // test-only
  issuer = new Issuer({ keria: KERIA, publicUrl: `http://${HOST}:${IPORT}`, displayName: "Test Community", dataDir: mkdtempSync(join(tmpdir(), "e2e-issuer-")),
    schemaDir: SCHEMA_DIR, sessionTtlMs: 600_000, logUrl: RP });
  const is = buildIssuerServer({ issuer, operatorToken: token });
  await new Promise<void>((r) => is.listen(IPORT, r));
  await issuer.init();
  rpDir = mkdtempSync(join(tmpdir(), "e2e-rp-"));
  rp = new RelyingParty({ keria: KERIA, dataDir: rpDir, displayName: "Test Log", community: "Test community", publicUrl: `http://${HOST}:${RPORT}`,
    schemaDir: SCHEMA_DIR, trustedIssuerAid: issuer.aid, trustedIssuerOobi: issuer.oobi, issuerUrl: `http://127.0.0.1:${IPORT}`, schemaSaid: SCHEMA_SAID,
    schemaOobi: `http://${HOST}:${RPORT}/oobi/${SCHEMA_SAID}`, sessionTtlMs: 1_200_000, maxTextLength: 500 });
  const rs = buildServer(rp);
  await new Promise<void>((r) => rs.listen(RPORT, r));
  servers = [is, rs];
  await rp.init();
  process.env.STANDIN_URL_REWRITES = `http://${HOST}:${IPORT}=http://127.0.0.1:${IPORT},http://${HOST}:${RPORT}=http://127.0.0.1:${RPORT}`;
  [alice, bob, rex, mallory] = [await enrol("alice"), await enrol("bob"), await enrol("rex"), await enrol("mallory")];
});

after(() => { for (const s of servers) s.close(); setTimeout(() => process.exit(), 500).unref(); });

test("genesis went through the gate and declares the semantics", async () => {
  const log = await getJson("/log.json");
  assert.equal(log.length, 1);
  assert.equal(log[0].payload.kind, "genesis");
  assert.equal(log[0].payload.semantics.base_score, "1/2");
  assert.equal(rp.gate.decisions()[0].decision, "accept");
});

test("SUCCESS CRITERION: A posts a claim, B attacks it, both see A's claim weaken", async () => {
  aliceSession = await openSession(alice, "kind=claim", true);
  const a = await post(aliceSession, alice, "claim", NON_ASCII);
  assert.equal(a.decision!.decision, "accept", JSON.stringify(a.decision));
  assert.equal((a.shown.shown as any).text, NON_ASCII, "the phone is shown the exact non-ASCII text");
  claim = a.decision!.record!;
  assert.equal((await strengths())[claim].strength, "1/2");

  const bobSession = await openSession(bob, `kind=attack&target=${claim}`, true);
  const b = await post(bobSession, bob, "attack", "The 2025 report found lead above the limit.", claim);
  assert.equal(b.decision!.decision, "accept", JSON.stringify(b.decision));
  const after = await strengths();
  assert.equal(after[claim].strength, "1/4");       // 1/2 − 1/2 × 1/2
  assert.equal(after[claim].display, "0.2500");
  const html = await (await fetch(`${RP}/`)).text();
  assert.ok(html.includes("0.2500") && html.includes("日本語") && html.includes("alice") && html.includes("bob"));
  const entry = await (await fetch(`${RP}/entry/${claim}`)).text();
  assert.ok(entry.includes("1/2 − 1/2 × 1/2") && entry.includes(alice.wallet.aid), "entry page shows the arithmetic and the author's identifier");
});

test("fewest phone steps: a second entry in the same session needs only a signature; a returning member does not present again", async () => {
  const again = await post(aliceSession, alice, "support", "The utility publishes monthly tests.", claim);
  assert.equal(again.decision!.decision, "accept");
  const back = await openSession(bob, `kind=attack&target=${claim}`, false);
  assert.equal(rp.session(back)!.presentedNow, false);
  const dup = await post(back, bob, "attack", "Same attack again, louder.", claim);
  assert.equal(dup.decision!.decision, "accept", "a duplicate is a valid signed entry");
  const s = await strengths();
  assert.equal(s[dup.decision!.record!].counted, false, "but only a member's first attack on a target counts");
  assert.equal(s[claim].strength, "1/2");          // one attacker at 1/2, one supporter at 1/2
});

test("gate rejects at 'signature': the wallet names an event that does not seal the entry", async () => {
  const before = rp.gate.log.length;
  const r = await post(aliceSession, alice, "claim", "never signed", undefined, { approve: true, lieAboutSn: "0" });
  assert.equal(r.decision!.decision, "reject");
  assert.equal(r.decision!.failed, "signature");
  assert.equal(rp.gate.log.length, before);
});

test("'Don't allow' on the phone writes nothing and decides nothing", async () => {
  const before = [rp.gate.log.length, rp.gate.decisions().length];
  const id = await openSession(alice, "kind=claim", false);
  await post(id, alice, "claim", "changed my mind", undefined, { approve: false });
  await sleep(3000); await rp.tick();
  assert.deepEqual([rp.gate.log.length, rp.gate.decisions().length], before);
});

test("gate rejects at 'membership': a really-signed entry citing someone else's credential, and one citing a credential never shown to us", async () => {
  mallorySession = await openSession(mallory, "kind=claim", true, false);   // scanned, so we can reach her phone; she has presented nothing
  const before = rp.gate.log.length;
  const stolen = entryPayload({ kind: "claim", text: "I am alice, honest", author: mallory.wallet.aid, credential: alice.said, log: rp.gate.genesis!.d });
  let d = await rp.gate.submit(stolen, await signedDirect(mallory, stolen));
  assert.deepEqual([d.decision, d.failed], ["reject", "membership"]);
  assert.match(d.checks[d.checks.length - 1].detail, /not to the author/);
  const unseen = entryPayload({ kind: "claim", text: "my own credential, never presented", author: mallory.wallet.aid, credential: mallory.said, log: rp.gate.genesis!.d });
  d = await rp.gate.submit(unseen, await signedDirect(mallory, unseen));
  assert.deepEqual([d.decision, d.failed], ["reject", "membership"]);
  assert.match(d.checks[d.checks.length - 1].detail, /never presented/);
  assert.equal(rp.gate.log.length, before);
});

test("gate rejects at 'target' and at 'request', with real signatures", async () => {
  await presentIn(mallorySession, mallory);
  assert.equal(rp.session(mallorySession)!.state, "verified");
  const before = rp.gate.log.length;
  const nowhere = entryPayload({ kind: "attack", text: "attacking nothing", target: rp.gate.genesis!.payload.d, author: mallory.wallet.aid, credential: mallory.said, log: rp.gate.genesis!.d });
  let d = await rp.gate.submit(nowhere, await signedDirect(mallory, nowhere));
  assert.deepEqual([d.decision, d.failed], ["reject", "target"]);
  const elsewhere = entryPayload({ kind: "claim", text: "signed for another log", author: mallory.wallet.aid, credential: mallory.said, log: claim });
  d = await rp.gate.submit(elsewhere, await signedDirect(mallory, elsewhere));
  assert.deepEqual([d.decision, d.failed], ["reject", "request"]);
  assert.equal(rp.gate.log.length, before);
});

test("presentation rejected: a credential issued to someone else", async () => {
  await alice.wallet.giveCopyTo(mallory.wallet, alice.said, `http://${HOST}:${IPORT}/oobi/${SCHEMA_SAID}`);
  const fresh = await WalletStandIn.create(KERIA, "thief");
  await alice.wallet.giveCopyTo(fresh, alice.said, `http://${HOST}:${IPORT}/oobi/${SCHEMA_SAID}`);
  const id = await openSession({ wallet: fresh, said: alice.said }, "kind=claim", true);
  assert.equal(rp.session(id)!.state, "rejected");
  assert.match(rp.session(id)!.rejection!, /someone else/);
});

test("REVOCATION: rex's earlier entry keeps counting; what he signs afterwards is rejected at 'standing'", async () => {
  rexSession = await openSession(rex, `kind=support&target=${claim}`, true);
  const early = await post(rexSession, rex, "support", "I drink it daily.", claim);
  assert.equal(early.decision!.decision, "accept");
  const beforeRev = (await strengths())[claim].strength;
  assert.equal(beforeRev, "5/8");                   // attack 1/2; support 1 − (1/2)(1/2) = 3/4; 1/2 + 1/2 × 1/4

  const out = await issuer.revokeAtCurrentHead(rex.said);
  assert.equal(out.head!.d, early.decision!.record, "the issuer sealed the log head, rex's entry, before revoking");

  const late = await post(rexSession, rex, "attack", "Posted after my membership was revoked.", claim);
  assert.deepEqual([late.decision!.decision, late.decision!.failed], ["reject", "standing"]);
  assert.deepEqual(late.decision!.checks.filter((c) => c.ok).map((c) => c.check).slice(0, 3), ["request", "signature", "signature"], "his key still works; that is not the point");
  assert.equal(rp.session(rexSession)!.state, "rejected");
  assert.equal((await strengths())[claim].strength, beforeRev, "earlier entry still counts, number unchanged");

  const again = await openSession(rex, "kind=claim", true);      // the agent's old copy is not reused once revoked
  assert.equal(rp.session(again)!.state, "rejected");
});

test("every rejection is on record with the check that failed", () => {
  const failed = rp.gate.decisions().filter((d) => d.decision === "reject").map((d) => d.failed).sort();
  assert.deepEqual(failed, ["membership", "membership", "request", "signature", "standing", "target"]);
});

test("the log is the only source of truth: a fresh gate on the same directory replays it; a damaged file is refused", () => {
  const replayed = new Gate({ dataDir: rpDir, issuer: issuer.aid, schema: SCHEMA_SAID, maxTextLength: 500 }, rp);
  assert.deepEqual(replayed.log.map((r) => r.d), rp.gate.log.map((r) => r.d));
  const copy = mkdtempSync(join(tmpdir(), "e2e-damaged-"));
  writeFileSync(join(copy, "log.jsonl"), readFileSync(join(rpDir, "log.jsonl"), "utf8").replace("lead above", "lead below"));
  assert.throws(() => new Gate({ dataDir: copy, issuer: issuer.aid, schema: SCHEMA_SAID, maxTextLength: 500 }, rp), /damaged/);
});

test("LESSON 3: the independent verifier, given only the export, reports the same authors and the same numbers; one changed byte fails", (t) => {
  const probe = spawnSync(PYTHON, ["-c", "import keri"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip(`SKIPPED: ${PYTHON} cannot import keripy (set VERIFIER_PYTHON to the interpreter with verifier/requirements.txt installed). The verifier was NOT exercised against this run.`);
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-export-"));
    const text = await (await fetch(`${RP}/export.json`)).text();
    writeFileSync(join(dir, "export.json"), text);
    const run = (file: string) => spawnSync(PYTHON, ["-m", "arglog_verifier", join(dir, file), "--issuer", issuer.aid, "--json"], { cwd: join(__dirname, "../../verifier"), encoding: "utf8", maxBuffer: 1 << 26 });
    const ok = run("export.json");
    assert.equal(ok.status, 0, ok.stdout.slice(-2000) + ok.stderr.slice(-2000));
    const report = JSON.parse(ok.stdout);
    const site = await strengths();
    assert.equal(report.entries.length, Object.keys(site).length);
    for (const e of report.entries) {
      assert.equal(e.ok, true, `${e.n} ${e.failed}`);
      assert.deepEqual([e.strength, e.display, e.counted, e.handle], [site[e.said].strength, site[e.said].display, site[e.said].counted, site[e.said].handle], `entry ${e.n}`);
    }
    writeFileSync(join(dir, "tampered.json"), text.replace("lead above", "lead below"));
    const bad = run("tampered.json");
    assert.equal(bad.status, 1);
    const broken = JSON.parse(bad.stdout).entries.filter((e: any) => !e.ok);
    assert.equal(broken[0].failed, "record");
  })();
});
