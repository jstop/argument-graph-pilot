// Spike: record real material from the live stack for the independent
// verifier to be built against, and answer four open questions:
//   Q1 what does the issuer agent's CESR export of a credential contain
//      (registry + iss/rev TEL events? witness receipts?)
//   Q2 does keyEvents().get() return the witness receipts of an ixn?
//   Q3 will a remote-sign request be delivered with NO prior presentation
//      (contact only)?
//   Q4 what does the RP's agent know about a credential's status without
//      a fresh presentation, after the issuer revokes?
// Writes to spike/out/10/ (git-ignored data stays out of the repo until
// reviewed). Throwaway code; findings go to DESIGN.md.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import signify, { type SignifyClient } from "signify-ts";
import { agentOobi, connect, installAsciiJsonBodies, resolveOobi, toadFor, waitOp, witnessAidsFromAgentConfig } from "../common/src";
import { WalletStandIn } from "../common/src/testing/wallet-standin";

const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
const SCHEMA_SAID = readFileSync(join(__dirname, "../schema/SAID"), "utf8").trim();
const PORT = 7731;
const BASE = `http://host.docker.internal:${PORT}`;
const OUT = join(__dirname, "out/10");
const now = () => new Date().toISOString().replace("Z", "000+00:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n── ${s}`);

async function service(name: string): Promise<{ client: SignifyClient; pre: string; oobi: string }> {
  const client = await connect(KERIA, signify.randomPasscode());
  const wits = await witnessAidsFromAgentConfig(client);
  await waitOp(client, await (await client.identifiers().create(name, { wits, toad: toadFor(wits.length) })).op());
  await waitOp(client, await (await client.identifiers().addEndRole(name, "agent", client.agent!.pre)).op());
  const pre = (await client.identifiers().get(name)).prefix;
  await waitOp(client, await (await client.identifiers().addEndRole(name, "indexer", pre)).op());
  await waitOp(client, await (await client.identifiers().addLocScheme(name, { url: BASE, scheme: "http" })).op());
  return { client, pre, oobi: await agentOobi(client, name) };
}

async function exportCesr(client: SignifyClient, said: string): Promise<string> {
  return (await client.credentials().get(said, true)) as unknown as string;
}

async function main() {
  await signify.ready();
  installAsciiJsonBodies();
  mkdirSync(OUT, { recursive: true });
  process.env.STANDIN_URL_REWRITES = `${BASE}=http://127.0.0.1:${PORT}`;
  const server = createServer((req, res) => {
    if (req.url === `/oobi/${SCHEMA_SAID}`) {
      res.setHeader("Content-Type", "application/schema+json");
      res.end(readFileSync(join(__dirname, `../schema/${SCHEMA_SAID}.json`)));
    } else { res.statusCode = 404; res.end(); }
  }).listen(PORT);

  step("issuer + registry, relying party");
  const issuer = await service("issuer");
  await waitOp(issuer.client, await (await issuer.client.registries().create({ name: "issuer", registryName: "members" })).op());
  const regk = (await issuer.client.registries().list("issuer"))[0].regk;
  await resolveOobi(issuer.client, `${BASE}/oobi/${SCHEMA_SAID}`);
  const rp = await service("log");
  await resolveOobi(rp.client, issuer.oobi, "issuer");
  await resolveOobi(rp.client, `${BASE}/oobi/${SCHEMA_SAID}`);
  console.log("issuer", issuer.pre, "registry", regk, "rp", rp.pre);

  step("three members: alice, bob, and rex (to be revoked); each gets a membership credential");
  const members: Record<string, { w: WalletStandIn; cred: string }> = {};
  for (const handle of ["alice", "bob", "rex"]) {
    const w = await WalletStandIn.create(KERIA, handle);
    await w.scan(`${issuer.oobi}?name=Community&externalId=iss-${handle}`);
    for (let i = 0; i < 40; i++) {
      if ((await issuer.client.contacts().list()).some((c: any) => c.id === w.aid)) break;
      await sleep(500);
    }
    const iss = await issuer.client.credentials().issue("issuer", { ri: regk, s: SCHEMA_SAID, a: { i: w.aid, handle } });
    await waitOp(issuer.client, iss.op);
    const [grant, gs, ge] = await issuer.client.ipex().grant({ senderName: "issuer", recipient: w.aid, acdc: iss.acdc, iss: iss.iss, anc: iss.anc, datetime: now() });
    await waitOp(issuer.client, await issuer.client.ipex().submitGrant("issuer", grant, gs, ge, [w.aid]));
    const cred = await w.acceptCredential(issuer.oobi);
    members[handle] = { w, cred };
    console.log(handle, w.aid, "credential", cred);
  }

  step("Q3: members scan the RP QR (contact only, NO presentation); RP sends remote-sign requests");
  const entries: any[] = [];
  async function signEntry(handle: string, body: Record<string, string>) {
    const m = members[handle];
    const [, payload] = signify.Saider.saidify({ d: "", ...body, author: m.w.aid, credential: m.cred, dt: new Date().toISOString() });
    const hab = await rp.client.identifiers().get("log");
    const [req, sigs, atc] = await rp.client.exchanges().createExchangeMessage(hab, "/remotesign/ixn/req", payload, {}, m.w.aid);
    await rp.client.exchanges().sendFromEvents("log", "remotesign", req, sigs, atc, [m.w.aid]);
    const { accepted } = await m.w.handleSignRequest({ approve: true });
    if (!accepted) throw new Error("stand-in refused");
    let sn = "";
    for (let i = 0; i < 60 && !sn; i++) {
      const { notes } = await rp.client.notifications().list();
      for (const n of notes) {
        if (n.a.r !== "/exn/remotesign/ixn/ref") continue;
        const exn = (await rp.client.exchanges().get(n.a.d)).exn;
        if (exn.p === req.ked.d) { sn = exn.a.sn; await rp.client.notifications().delete(n.i); }
      }
      if (!sn) await sleep(500);
    }
    await waitOp(rp.client, await rp.client.keyStates().query(m.w.aid, sn));
    const kel: any[] = await rp.client.keyEvents().get(m.w.aid);
    const ev = kel.find((e) => e.ked.s === sn);
    entries.push({ handle, payload, sn, event: ev.ked, atc: ev.atc });
    console.log(handle, "signed", payload.d, "at sn", sn, "| atc head:", String(ev.atc).slice(0, 12), "len", String(ev.atc).length);
    return payload.d as string;
  }
  for (const h of ["alice", "bob", "rex"]) await members[h].w.scan(`${rp.oobi}?name=ArgumentLog&externalId=rp-${h}`);
  await sleep(3000);
  const c1 = await signEntry("alice", { kind: "claim", text: "Tap water here is safe to drink. — naïve? 日本語 ✓" });
  await signEntry("bob", { kind: "attack", text: "The 2025 report found lead above the limit.", target: c1 });
  await signEntry("rex", { kind: "support", text: "I drink it daily.", target: c1 });
  console.log("Q3 answer: remote-sign delivered and answered with no presentation in this session");

  step("Q4 (before): what the RP agent knows about rex's credential without a presentation");
  console.log("rp credentials().get:", await rp.client.credentials().get(members.rex.cred).then((c: any) => c.status?.et, (e: any) => `ERR ${e.message}`));
  console.log("rp credentials().state:", await rp.client.credentials().state(regk, members.rex.cred).then((s: any) => JSON.stringify(s), (e: any) => `ERR ${e.message}`));

  step("export BEFORE revocation (issuer agent, CESR)");
  writeFileSync(join(OUT, "rex-before-revoke.cesr"), await exportCesr(issuer.client, members.rex.cred));

  step("issuer revokes rex; rex signs afterwards (his key still works)");
  const rev = await issuer.client.credentials().revoke("issuer", members.rex.cred, now());
  await waitOp(issuer.client, rev.op);
  await signEntry("rex", { kind: "attack", text: "Posted after my membership was revoked.", target: c1 });

  step("Q4 (after): RP agent's view, polled 10 s");
  for (let i = 0; i < 5; i++) {
    console.log("  state:", await rp.client.credentials().state(regk, members.rex.cred).then((s: any) => s.et, (e: any) => `ERR ${e.message}`));
    await sleep(2000);
  }

  step("Q1: exports from the issuer agent");
  for (const h of Object.keys(members)) {
    const cesr = await exportCesr(issuer.client, members[h].cred);
    writeFileSync(join(OUT, `${h}.cesr`), cesr);
    const types = [...cesr.matchAll(/"t":"([a-z]{3})"/g)].map((m) => m[1]);
    console.log(h, "bytes", cesr.length, "event types:", types.join(","), "| has -B witness sigs:", /-BA[A-Z]/.test(cesr), "| ACDC:", cesr.includes('{"v":"ACDC'));
  }
  step("holder KELs as the RP agent holds them (ked + atc per event)");
  const kels: Record<string, any[]> = {};
  for (const h of Object.keys(members)) kels[members[h].w.aid] = await rp.client.keyEvents().get(members[h].w.aid);
  kels[issuer.pre] = await rp.client.keyEvents().get(issuer.pre);
  writeFileSync(join(OUT, "kels.json"), JSON.stringify(kels, null, 1));
  writeFileSync(join(OUT, "entries.json"), JSON.stringify({ issuer: issuer.pre, registry: regk, schema: SCHEMA_SAID, rp: rp.pre,
    members: Object.fromEntries(Object.entries(members).map(([h, m]) => [h, { aid: m.w.aid, credential: m.cred }])), entries }, null, 1));
  const st = await rp.client.keyStates().get(members.alice.w.aid);
  console.log("alice key state: toad", st[0]?.bt, "wits", st[0]?.b?.length);
  server.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("\nSPIKE FAILED:", e); process.exit(1); });
