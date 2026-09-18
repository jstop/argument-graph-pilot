// Records a REAL log from the live stack as fixtures for the independent
// verifier: real KERIA, real witnesses, Signify clients as the phones.
// Nothing here is mocked; the private keys die with this process.
//
//   npx tsx spike/11-record-log.ts        -> verifier/tests/fixtures/*.json
//
// Writes two exports of the same log:
//   recorded.json                 genesis, alice's claim, bob's attack, rex's
//                                 support; then the issuer checkpoints the log
//                                 head and revokes rex. Everything is valid.
//   recorded-post-revocation.json the same plus an entry rex signs AFTER the
//                                 revocation. The relying party's gate would
//                                 never write it; this file imitates a
//                                 dishonest operator who appended it anyway.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import signify, { type SignifyClient } from "signify-ts";
import { agentOobi, connect, installAsciiJsonBodies, resolveOobi, toadFor, waitOp, witnessAidsFromAgentConfig } from "../common/src";
import { entryPayload, EXPORT_FORMAT, genesisPayload, makeRecord, type Anchor, type Kind, type LogRecord } from "../common/src/log";
import { WalletStandIn } from "../common/src/testing/wallet-standin";

const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
const SCHEMA_SAID = readFileSync(join(__dirname, "../schema/SAID"), "utf8").trim();
const PORT = 7731;
const BASE = `http://host.docker.internal:${PORT}`;
const OUT = join(__dirname, "../verifier/tests/fixtures");
const now = () => new Date().toISOString().replace("Z", "000+00:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function service(name: string) {
  const client = await connect(KERIA, signify.randomPasscode());
  const wits = await witnessAidsFromAgentConfig(client);
  await waitOp(client, await (await client.identifiers().create(name, { wits, toad: toadFor(wits.length) })).op());
  await waitOp(client, await (await client.identifiers().addEndRole(name, "agent", client.agent!.pre)).op());
  const pre = (await client.identifiers().get(name)).prefix;
  await waitOp(client, await (await client.identifiers().addEndRole(name, "indexer", pre)).op());
  await waitOp(client, await (await client.identifiers().addLocScheme(name, { url: BASE, scheme: "http" })).op());
  return { client, name, pre, oobi: await agentOobi(client, name) };
}

/** Seal a digest in our own key event log and return the receipted event. */
async function sealOwn(svc: { client: SignifyClient; name: string; pre: string }, said: string): Promise<Anchor> {
  const ixn = await svc.client.identifiers().interact(svc.name, { d: said });
  await waitOp(svc.client, await ixn.op());
  const sn = ixn.serder.ked.s as string;
  const ev = (await svc.client.keyEvents().get(svc.pre)).find((e: any) => e.ked.s === sn);
  return { s: sn, d: ev.ked.d, ked: ev.ked, atc: ev.atc };
}

async function main() {
  await signify.ready();
  installAsciiJsonBodies();
  mkdirSync(OUT, { recursive: true });
  process.env.STANDIN_URL_REWRITES = `${BASE}=http://127.0.0.1:${PORT}`;
  const server = createServer((req, res) => {
    if (req.url === `/oobi/${SCHEMA_SAID}`) { res.setHeader("Content-Type", "application/schema+json"); res.end(readFileSync(join(__dirname, `../schema/${SCHEMA_SAID}.json`))); }
    else { res.statusCode = 404; res.end(); }
  }).listen(PORT);

  const issuer = await service("issuer");
  await waitOp(issuer.client, await (await issuer.client.registries().create({ name: "issuer", registryName: "members" })).op());
  const regk = (await issuer.client.registries().list("issuer"))[0].regk;
  await resolveOobi(issuer.client, `${BASE}/oobi/${SCHEMA_SAID}`);
  const op = await service("log");
  await resolveOobi(op.client, issuer.oobi, "issuer");

  const gp = genesisPayload({ community: "Recorded fixture community", issuer: issuer.pre, schema: SCHEMA_SAID, operator: op.pre });
  const log: LogRecord<any>[] = [makeRecord(null, gp, await sealOwn(op, gp.d))];
  console.log("genesis", log[0].d);

  const members: Record<string, { w: WalletStandIn; cred: string }> = {};
  for (const handle of ["alice", "bob", "rex"]) {
    const w = await WalletStandIn.create(KERIA, handle);
    await w.scan(`${issuer.oobi}?name=Community&externalId=iss-${handle}`);
    for (let i = 0; i < 40 && !(await issuer.client.contacts().list()).some((c: any) => c.id === w.aid); i++) await sleep(500);
    const iss = await issuer.client.credentials().issue("issuer", { ri: regk, s: SCHEMA_SAID, a: { i: w.aid, handle } });
    await waitOp(issuer.client, iss.op);
    const [grant, gs, ge] = await issuer.client.ipex().grant({ senderName: "issuer", recipient: w.aid, acdc: iss.acdc, iss: iss.iss, anc: iss.anc, datetime: now() });
    await waitOp(issuer.client, await issuer.client.ipex().submitGrant("issuer", grant, gs, ge, [w.aid]));
    members[handle] = { w, cred: await w.acceptCredential(issuer.oobi) };
    await w.scan(`${op.oobi}?name=ArgumentLog&externalId=rp-${handle}`);
    console.log(handle, w.aid, members[handle].cred);
  }
  await sleep(2000);

  async function signed(handle: string, kind: Kind, text: string, target?: string): Promise<{ payload: any; anchor: Anchor }> {
    const m = members[handle];
    const payload = entryPayload({ kind, text, target, author: m.w.aid, credential: m.cred, log: log[0].d });
    const hab = await op.client.identifiers().get("log");
    const [req, sigs, atc] = await op.client.exchanges().createExchangeMessage(hab, "/remotesign/ixn/req", payload as any, {}, m.w.aid);
    await op.client.exchanges().sendFromEvents("log", "remotesign", req, sigs, atc, [m.w.aid]);
    if (!(await m.w.handleSignRequest({ approve: true })).accepted) throw new Error("stand-in refused");
    let sn = "";
    for (let i = 0; i < 60 && !sn; i++) {
      for (const n of (await op.client.notifications().list()).notes) {
        if (n.a.r !== "/exn/remotesign/ixn/ref") continue;
        const exn = (await op.client.exchanges().get(n.a.d)).exn;
        if (exn.p === req.ked.d) { sn = exn.a.sn; await op.client.notifications().delete(n.i); }
      }
      if (!sn) await sleep(500);
    }
    await waitOp(op.client, await op.client.keyStates().query(m.w.aid, sn));
    const ev = (await op.client.keyEvents().get(m.w.aid)).find((e: any) => e.ked.s === sn);
    return { payload, anchor: { s: sn, d: ev.ked.d, ked: ev.ked, atc: ev.atc } };
  }
  const append = (l: LogRecord<any>[], s: { payload: any; anchor: Anchor }) => { l.push(makeRecord(l[l.length - 1], s.payload, s.anchor)); return l[l.length - 1].d; };

  const c1 = append(log, await signed("alice", "claim", "Tap water here is safe to drink. — naïve? 日本語 ✓"));
  append(log, await signed("bob", "attack", "The 2025 report found lead above the limit.", c1));
  append(log, await signed("rex", "support", "I drink it daily.", c1));

  console.log("issuer checkpoints log head", log[log.length - 1].d, "then revokes rex");
  await sealOwn(issuer, log[log.length - 1].d);
  await waitOp(issuer.client, (await issuer.client.credentials().revoke("issuer", members.rex.cred, now())).op);

  const late = await signed("rex", "attack", "Posted after my membership was revoked.", c1);

  async function bundle(l: LogRecord<any>[]) {
    const kels: Record<string, any[]> = {};
    for (const aid of [op.pre, issuer.pre, ...Object.values(members).map((m) => m.w.aid)]) {
      if (aid !== op.pre) await waitOp(op.client, await op.client.keyStates().query(aid));
      kels[aid] = await op.client.keyEvents().get(aid);
    }
    const credentials: Record<string, string> = {};
    for (const m of Object.values(members)) credentials[m.cred] = (await issuer.client.credentials().get(m.cred, true)) as unknown as string;
    return { format: EXPORT_FORMAT, log: l, kels, credentials };
  }
  writeFileSync(join(OUT, "recorded.json"), JSON.stringify(await bundle(log), null, 1));
  const bad = [...log]; append(bad, late);
  writeFileSync(join(OUT, "recorded-post-revocation.json"), JSON.stringify(await bundle(bad), null, 1));
  console.log("wrote fixtures to", OUT);
  server.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
