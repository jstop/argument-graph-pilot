// Integration: needs the backend up (infra/stack.sh up). Talks to the real
// KERIA and the real witnesses; nothing KERI here is mocked. The only
// stand-in besides the phone is a tiny HTTP server answering /log/head,
// because the relying party's log is a separate service.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import signify from "signify-ts";
import { connect, resolveOobi, waitOp } from "@pilot/common";
import { WalletStandIn } from "@pilot/common/src/testing/wallet-standin";
import { CheckpointError, Issuer, type IssuerConfig } from "../src/core";
import { HandleError } from "../src/handle";
import { buildServer, describeInception } from "../src/server";

const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
// demo2's own tests use 3911/3921/3922; stay clear of them.
const PORT = 3931;
const LOG_STUB_PORT = 3932;
const DEAD_PORT = 3933; // nothing listens here
// KERIA runs in a container; this is how it reaches a server on the host.
const PUBLIC_URL = process.env.TEST_ISSUER_PUBLIC_URL ?? `http://host.docker.internal:${PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const HANDLE = "alice";
const NON_ASCII = `Zo${String.fromCodePoint(0xeb)} ${String.fromCodePoint(0x65e5, 0x672c)}`;
const TOKEN = "test-operator-token-0123456789"; // test-only
const AUTH = { Authorization: "Basic " + Buffer.from(`operator:${TOKEN}`).toString("base64") };
// A well-formed SAID standing in for the relying party's log head. The
// issuer treats it as opaque; the KEL it gets anchored in is the real one.
const HEAD = { n: 7, d: "Elog-head-checkpoint-test".padEnd(44, "_") };

let issuer: Issuer;
let server: Server;
let logStub: Server;
let config: IssuerConfig;

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await issuer.tick();
    const got = await probe();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Issues to a fresh stand-in phone and has it accept. */
async function member(handle: string): Promise<{ wallet: WalletStandIn; said: string }> {
  const wallet = await WalletStandIn.create(KERIA);
  const session = issuer.createSession(handle);
  await wallet.scan(issuer.qrUrl(session));
  await until("grant", () => issuer.session(session.id)?.state === "granted" || undefined);
  return { wallet, said: await wallet.acceptCredential(issuer.oobi) };
}

/** The issuer's KEL as KERIA holds it: [{ked, atc}], index == sn. */
async function issuerKel(): Promise<any[]> {
  return (issuer as any).client.keyEvents().get(issuer.aid);
}

before(async () => {
  config = {
    keria: KERIA, publicUrl: PUBLIC_URL, displayName: "Test Issuer",
    dataDir: mkdtempSync(join(tmpdir(), "issuer-test-")),
    schemaDir: join(__dirname, "../../schema"), sessionTtlMs: 60_000,
    logUrl: `http://127.0.0.1:${DEAD_PORT}`,
  };
  issuer = new Issuer(config); // the issuer keeps this object, so tests can re-point logUrl
  logStub = createServer((req, res) => {
    if (req.url !== "/log/head") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(HEAD));
  });
  await new Promise<void>((r) => logStub.listen(LOG_STUB_PORT, r));
  server = buildServer({ issuer, operatorToken: TOKEN });
  await new Promise<void>((r) => server.listen(PORT, r));
  await issuer.init();
});

after(() => { server?.close(); logStub?.close(); });

test("inception: witnessed by all our witnesses, pre-rotation committed", async () => {
  const state = await issuer.keyState();
  assert.equal(state.witnesses.length, 6);
  assert.equal(state.threshold, 4);
  assert.equal(state.nextKeyDigests.length, 1, "a next key is committed before it is ever used");

  const inception = describeInception(await issuer.inceptionEvent());
  assert.equal(inception.controllerSignatures, 1);
  assert.ok(inception.witnessReceipts >= state.threshold, `receipts ${inception.witnessReceipts} < threshold`);
});

test("issue -> wallet accepts; the credential has a handle and nothing else; a third party can resolve the issuer", async () => {
  const wallet = await WalletStandIn.create(KERIA);
  const session = issuer.createSession(HANDLE);
  await wallet.scan(issuer.qrUrl(session));

  await until("grant", () => issuer.session(session.id)?.state === "granted" || undefined);
  assert.equal(issuer.session(session.id)!.holderAid, wallet.aid, "session bound to the phone that scanned");

  const said = await wallet.acceptCredential(issuer.oobi);
  assert.equal(said, issuer.session(session.id)!.credentialSaid);
  await until("admit seen by issuer", () => issuer.session(session.id)?.state === "admitted" || undefined);

  const held = (await wallet.credentials(issuer.schemaSaid))[0];
  assert.deepEqual(Object.keys(held.sad.a).sort(), ["d", "dt", "handle", "i"], "i, dt, handle (d is the block's own SAID)");
  assert.equal(held.sad.a.handle, HANDLE);
  assert.equal(held.sad.a.i, wallet.aid);
  assert.doesNotMatch(JSON.stringify(held.sad), /score|aggregate|role|reputation/i);
  assert.equal(held.sad.ri, issuer.registry);

  // A third party that knows nothing but the issuer's OOBI.
  await signify.ready();
  const verifier = await connect(KERIA, signify.randomPasscode());
  await resolveOobi(verifier, issuer.oobi);
  await resolveOobi(verifier, `${PUBLIC_URL}/oobi/${issuer.schemaSaid}`);
  const state = await waitOp<any>(verifier, await verifier.keyStates().query(issuer.aid));
  assert.equal(state.response.i, issuer.aid);
  assert.equal(state.response.b.length, 6, "and sees which witnesses back it");
  assert.equal(held.sad.i, issuer.aid);
  assert.equal(held.sad.s, issuer.schemaSaid);
  assert.equal(held.status.et, "iss");
});

test("a non-ASCII handle round-trips to the wallet intact", async () => {
  const { wallet, said } = await member(NON_ASCII);
  const held = await wallet.client.credentials().get(said);
  assert.equal(held.sad.a.handle, NON_ASCII);
  assert.ok((await issuer.members()).some((m) => m.said === said && m.handle === NON_ASCII && m.memberAid === wallet.aid));
});

test("credentials issued before a key rotation still verify after it", async () => {
  const { wallet, said } = await member(HANDLE);

  const before = await issuer.keyState();
  const sn = await issuer.rotate();
  const afterState = await issuer.keyState();
  assert.equal(sn, before.sn + 1);
  assert.notDeepEqual(afterState.nextKeyDigests, before.nextKeyDigests, "a fresh next key is committed");

  const held = await wallet.client.credentials().get(said);
  assert.equal(held.status.et, "iss");

  // and issuing keeps working with the rotated key
  await member("after-rotation");
});

test("reject: a session QR works once; a second phone scanning it gets nothing", async () => {
  const first = await WalletStandIn.create(KERIA, "First Phone");
  const second = await WalletStandIn.create(KERIA, "Second Phone");
  const session = issuer.createSession(HANDLE);
  const qr = issuer.qrUrl(session);

  await first.scan(qr);
  await until("grant", () => issuer.session(session.id)?.state === "granted" || undefined);
  await second.scan(qr);
  for (let i = 0; i < 8; i++) { await issuer.tick(); await new Promise((r) => setTimeout(r, 400)); }

  assert.equal(issuer.session(session.id)!.holderAid, first.aid);
  await assert.rejects(second.waitForNotification("/exn/ipex/grant", 4_000), /no \/exn\/ipex\/grant/);
});

test("reject: an expired session issues nothing", async () => {
  const wallet = await WalletStandIn.create(KERIA);
  const session = issuer.createSession(HANDLE);
  const count = (await issuer.members()).length;
  (issuer.session(session.id) as any).expiresAt = new Date(Date.now() - 1000).toISOString();
  await wallet.scan(issuer.qrUrl(session));
  for (let i = 0; i < 6; i++) { await issuer.tick(); await new Promise((r) => setTimeout(r, 400)); }
  assert.equal(issuer.session(session.id)!.state, "expired");
  await assert.rejects(wallet.waitForNotification("/exn/ipex/grant", 3_000));
  assert.equal((await issuer.members()).length, count);
});

test("reject: bad handles create no session; KERIA itself refuses out-of-schema attributes if our validation is bypassed", async () => {
  const nul = String.fromCharCode(0), nl = String.fromCharCode(10);
  for (const bad of ["", "   ", "x".repeat(41), `a${nl}b`, `a${nul}b`, 5, null, { handle: "x" }]) {
    assert.throws(() => issuer.createSession(bad), HandleError, JSON.stringify(bad));
  }
  const wallet = await WalletStandIn.create(KERIA);
  const count = (await issuer.members()).length;
  await assert.rejects(issuer.issueTo(wallet.aid, "x".repeat(41)), "the schema says maxLength 40");
  await assert.rejects(
    (async () => {
      const res = await (issuer as any).client.credentials().issue("issuer", {
        ri: issuer.registry, s: issuer.schemaSaid, a: { i: wallet.aid, handle: HANDLE, score_1: 7 },
      });
      await waitOp((issuer as any).client, res.op);
    })(),
    "the schema says additionalProperties: false"
  );
  assert.equal((await issuer.members()).length, count);
});

test("HTTP: schema and /registry are public; the operator API is not", async () => {
  const schema = await fetch(`${BASE}/oobi/${issuer.schemaSaid}`);
  assert.equal(schema.status, 200);
  assert.equal(schema.headers.get("content-type"), "application/schema+json");
  assert.equal((await schema.json()).$id, issuer.schemaSaid);

  const someSaid = (await issuer.members()).find((m) => m.status === "iss")!.said;
  const operatorOnly = [["GET", "/"], ["GET", "/api/issuer"], ["GET", "/api/members"], ["POST", "/api/sessions"],
    ["POST", "/api/checkpoint"], ["POST", `/api/members/${someSaid}/revoke`]];
  const wrong = { Authorization: "Basic " + Buffer.from("operator:nope").toString("base64") };
  for (const [method, path] of operatorOnly) {
    assert.equal((await fetch(BASE + path, { method })).status, 401, `${method} ${path} without credentials`);
    assert.equal((await fetch(BASE + path, { method, headers: wrong })).status, 401, `${method} ${path} with wrong credentials`);
  }
  assert.equal((await issuer.members()).find((m) => m.said === someSaid)!.status, "iss", "and none of that revoked anything");

  for (const bad of [{ handle: "" }, { handle: "x".repeat(41) }, { handle: "ok", role: "admin" }, { score_1: 7 }]) {
    assert.equal((await fetch(`${BASE}/api/sessions`, { method: "POST", headers: AUTH, body: JSON.stringify(bad) })).status, 400, JSON.stringify(bad));
  }
  const ok = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: AUTH, body: JSON.stringify({ handle: ` ${NON_ASCII} ` }) });
  assert.equal(ok.status, 201);
  const view = await ok.json();
  assert.equal(view.handle, NON_ASCII);
  assert.match(view.qrSvg, /<svg/);
  assert.equal(new URL(view.qrUrl).searchParams.get("externalId"), view.id);
  assert.match(await (await fetch(`${BASE}/`, { headers: AUTH })).text(), /name="handle"/);

  // members: operator only, with handles. registry: public, without.
  const members = await (await fetch(`${BASE}/api/members`, { headers: AUTH })).json();
  assert.ok(members.length >= 1);
  for (const m of members) assert.deepEqual(Object.keys(m).sort(), ["handle", "memberAid", "said", "status"]);

  const registry = await fetch(`${BASE}/registry`);
  assert.equal(registry.status, 200);
  const listing = await registry.json();
  assert.equal(listing.issuer, issuer.aid);
  assert.equal(listing.registry, issuer.registry);
  assert.deepEqual(listing.credentials.map((c: any) => c.said).sort(), members.map((m: any) => m.said).sort());
  for (const c of listing.credentials) assert.deepEqual(Object.keys(c).sort(), ["said", "status"]);

  const cesr = await fetch(`${BASE}/registry/${someSaid}.cesr`);
  assert.equal(cesr.status, 200);
  assert.equal(cesr.headers.get("content-type"), "application/json+cesr");
  const text = await cesr.text();
  assert.ok(text.includes('"t":"icp"') && text.includes(issuer.aid), "issuer KEL");
  assert.ok(text.includes('"t":"vcp"'), "registry inception");
  assert.ok(text.includes('"t":"iss"') && text.includes(someSaid), "issuance event and credential");
  assert.ok(!text.includes('"t":"rev"'));
  assert.equal((await fetch(`${BASE}/registry/${issuer.aid}.cesr`)).status, 404, "a SAID we never issued");
});

test("reject: a credential merely held by the issuer's agent is not exported, listed or revocable as ours", async () => {
  // Another issuer's membership-schema credential, granted to and admitted by OUR agent.
  const other = await WalletStandIn.create(KERIA, "Other Issuer");
  const client = (issuer as any).client;
  const schemaOobi = `${PUBLIC_URL}/oobi/${issuer.schemaSaid}`;
  await resolveOobi(other.client, schemaOobi);
  await waitOp(other.client, await (await other.client.registries().create({ name: other.name, registryName: "elsewhere" })).op());
  const regk = (await other.client.registries().list(other.name))[0].regk;
  const foreign = await other.client.credentials().issue(other.name, { ri: regk, s: issuer.schemaSaid, a: { i: issuer.aid, handle: "foreign" } });
  await waitOp(other.client, foreign.op);
  const said = foreign.acdc.ked.d as string;

  await other.scan(issuer.oobi); // introduces `other` to our agent
  const now = new Date().toISOString().replace("Z", "000+00:00");
  const [grant, sigs, end] = await other.client.ipex().grant({
    senderName: other.name, recipient: issuer.aid, datetime: now, acdc: foreign.acdc, iss: foreign.iss, anc: foreign.anc,
  });
  await waitOp(other.client, await other.client.ipex().submitGrant(other.name, grant, sigs, end, [issuer.aid]));
  let note: any;
  for (let i = 0; i < 75 && !note; i++) {
    note = (await client.notifications().list()).notes.find((n: any) => n.a.r === "/exn/ipex/grant" && n.a.d === grant.ked.d);
    if (!note) await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(note, "grant reached the issuer's agent");
  const [admit, aSigs, aEnd] = await client.ipex().admit({ senderName: "issuer", recipient: other.aid, grantSaid: grant.ked.d, message: "", datetime: now });
  await waitOp(client, await client.ipex().submitAdmit("issuer", admit, aSigs, aEnd, [other.aid]));
  let held: any;
  for (let i = 0; i < 75 && !held; i++) {
    held = await client.credentials().get(said).catch(() => undefined);
    if (!held) await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(held, "the foreign credential now sits in the issuer's own store");

  assert.equal(await issuer.exportCesr(said), undefined);
  assert.equal((await fetch(`${BASE}/registry/${said}.cesr`)).status, 404);
  assert.ok(!(await issuer.members()).some((m) => m.said === said));
  const sn = (await issuer.keyState()).sn;
  await assert.rejects(issuer.revoke(said, HEAD.d), /no credential/);
  assert.equal((await issuer.keyState()).sn, sn);
});

test("revoke refuses, and anchors nothing, when the log head cannot be fetched", async () => {
  const { said } = await member("to-be-kept");
  const before = (await issuer.keyState()).sn;

  config.logUrl = `http://127.0.0.1:${DEAD_PORT}`;
  await assert.rejects(issuer.revokeAtCurrentHead(said),
    (e: Error) => e instanceof CheckpointError && /refusing to revoke/.test(e.message) && /Nothing was anchored/.test(e.message));
  const res = await fetch(`${BASE}/api/members/${said}/revoke`, { method: "POST", headers: AUTH });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /refusing to revoke/);
  assert.equal((await fetch(`${BASE}/api/checkpoint`, { method: "POST", headers: AUTH })).status, 502);

  config.logUrl = undefined;
  await assert.rejects(issuer.revokeAtCurrentHead(said), /LOG_URL is not set/);

  config.logUrl = BASE; // answers, but /log/head there is a 401, not a head
  await assert.rejects(issuer.revokeAtCurrentHead(said), /refusing to revoke/);

  assert.equal((await issuer.keyState()).sn, before, "issuer KEL untouched");
  assert.equal((await issuerKel()).length, before + 1);
  assert.equal((await issuer.members()).find((m) => m.said === said)!.status, "iss");
});

test("revoke checkpoints first: {d: head} at sn N, the revocation at sn N+1; the public export then carries the rev", async () => {
  const { wallet, said } = await member("rex");
  config.logUrl = `http://127.0.0.1:${LOG_STUB_PORT}`;
  const before = (await issuer.keyState()).sn;

  const res = await fetch(`${BASE}/api/members/${said}/revoke`, { method: "POST", headers: AUTH });
  const done = await res.json();
  assert.equal(res.status, 200, JSON.stringify(done));
  assert.deepEqual(done.head, HEAD);
  assert.equal(done.checkpointSn, before + 1);
  assert.equal(done.revocationSn, before + 2);

  const kel = await issuerKel();
  assert.equal(kel.length, before + 3);
  const checkpoint = kel[before + 1], revocation = kel[before + 2];
  assert.equal(checkpoint.ked.t, "ixn");
  assert.equal(parseInt(checkpoint.ked.s, 16), before + 1);
  assert.deepEqual(checkpoint.ked.a, [{ d: HEAD.d }], "digest-only seal of the log head, nothing else");
  assert.equal(revocation.ked.t, "ixn");
  assert.equal(parseInt(revocation.ked.s, 16), before + 2);
  assert.equal(revocation.ked.a.length, 1);
  assert.equal(revocation.ked.a[0].i, said, "the anchor of the credential's rev event");
  assert.equal(revocation.ked.a[0].s, "1");
  for (const ev of [checkpoint, revocation]) {
    const counted = describeInception(ev);
    assert.equal(counted.controllerSignatures, 1);
    assert.ok(counted.witnessReceipts >= 4, `witness receipts ${counted.witnessReceipts} < threshold`);
  }

  assert.equal((await issuer.members()).find((m) => m.said === said)!.status, "rev");
  const listing = await (await fetch(`${BASE}/registry`)).json();
  assert.equal(listing.credentials.find((c: any) => c.said === said).status, "rev");
  const text = await (await fetch(`${BASE}/registry/${said}.cesr`)).text();
  assert.ok(text.includes('"t":"rev"'), "export contains the revocation event");
  assert.ok(text.includes(HEAD.d), "and the issuer KEL with the checkpoint");
  assert.equal((await wallet.client.credentials().get(said)).sad.a.handle, "rex");

  // twice is an error, and anchors nothing more
  assert.equal((await fetch(`${BASE}/api/members/${said}/revoke`, { method: "POST", headers: AUTH })).status, 409);
  assert.equal((await issuer.keyState()).sn, before + 2);
});

test("checkpoint alone anchors the head; noCheckpoint revokes with one event and a loud warning", async () => {
  const { said } = await member("no-checkpoint");
  config.logUrl = `http://127.0.0.1:${LOG_STUB_PORT}`;
  const before = (await issuer.keyState()).sn;
  const cp = await (await fetch(`${BASE}/api/checkpoint`, { method: "POST", headers: AUTH })).json();
  assert.deepEqual(cp, { head: HEAD, sn: before + 1 });
  assert.deepEqual((await issuerKel())[before + 1].ked.a, [{ d: HEAD.d }]);

  config.logUrl = `http://127.0.0.1:${DEAD_PORT}`;
  assert.equal((await fetch(`${BASE}/api/members/${said}/revoke`, { method: "POST", headers: AUTH, body: '{"noCheckpoint":"yes"}' })).status, 400);
  const warnings: string[] = [];
  const done = await issuer.revokeAtCurrentHead(said, { noCheckpoint: true }, (m) => warnings.push(m));
  assert.equal(done.checkpointSn, undefined);
  assert.equal(done.revocationSn, before + 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WITHOUT A LOG CHECKPOINT[^]*reject ALL/);
  assert.equal((await issuerKel()).length, before + 3, "one more event: the revocation, no checkpoint");
  assert.equal((await issuer.members()).find((m) => m.said === said)!.status, "rev");
});
