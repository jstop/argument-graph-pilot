// The success criterion against the RUNNING services (containers from
// infra/services.sh), through their HTTP APIs as a browser would, with
// wallet stand-ins as the two phones. Then downloads the export, the way
// a third person would. Proves the deployed processes, not the classes.
//
//   OPERATOR_TOKEN=... npx tsx spike/12-drive-services.ts            (local)
//   OPERATOR_TOKEN=... PILOT_DOMAIN=pilot.example.com npx tsx ...    (cloud)
// There is no fallback token (demo2's spike/06 had one hardcoded).
import { writeFileSync } from "node:fs";
import { installAsciiJsonBodies } from "../common/src";
import { WalletStandIn } from "../common/src/testing/wallet-standin";

const D = process.env.PILOT_DOMAIN;
const KERIA = D ? { url: `https://keria.${D}`, bootUrl: `https://keria-boot.${D}` } : { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
const ISSUER = D ? `https://issuer.${D}` : "http://127.0.0.1:3110";
const RP = D ? `https://${process.env.RP_SUBDOMAIN ?? "claims"}.${D}` : "http://127.0.0.1:3120";
if (!process.env.OPERATOR_TOKEN) { console.error("set OPERATOR_TOKEN (from infra/services.env)"); process.exit(2); }
const AUTH = { Authorization: "Basic " + Buffer.from(`operator:${process.env.OPERATOR_TOKEN}`).toString("base64") };
if (!D) process.env.STANDIN_URL_REWRITES = "http://arglog-issuer:3110=http://127.0.0.1:3110,http://arglog-log:3120=http://127.0.0.1:3120";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(url: string, until: (s: any) => boolean, headers = {}, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const s = await (await fetch(url, { headers })).json(); if (until(s)) return s; await sleep(1000); }
  throw new Error(`timeout polling ${url}`);
}

async function enrol(handle: string) {
  const phone = await WalletStandIn.create(KERIA, handle);
  let s = await (await fetch(`${ISSUER}/api/sessions`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ handle }) })).json();
  const issuerOobi = s.qrUrl.split("?")[0];
  await phone.scan(s.qrUrl);
  s = await poll(`${ISSUER}/api/sessions/${s.id}`, (x) => ["granted", "failed"].includes(x.state), AUTH);
  if (s.state !== "granted") throw new Error(`issuance failed: ${JSON.stringify(s)}`);
  const said = await phone.acceptCredential(issuerOobi);
  console.log(`${handle}: ${phone.aid} holds membership ${said}`);
  return { phone, said };
}

async function postEntry(m: { phone: WalletStandIn; said: string }, kind: string, text: string, target?: string): Promise<string> {
  const start = await fetch(`${RP}/start?kind=${kind}${target ? `&target=${target}` : ""}`, { redirect: "manual" });
  const id = start.headers.get("location")!.split("/s/")[1].split("?")[0];
  let s = await (await fetch(`${RP}/api/sessions/${id}`)).json();
  await m.phone.scan(s.qrUrl);
  s = await poll(`${RP}/api/sessions/${id}`, (x) => x.state !== "waiting-for-scan");
  if (s.state === "requesting") { const p = m.phone.present(m.said); s = await poll(`${RP}/api/sessions/${id}`, (x) => ["verified", "rejected"].includes(x.state)); await p; }
  if (s.state !== "verified") throw new Error(`not verified: ${s.state} ${s.rejection}`);
  await fetch(`${RP}/api/sessions/${id}/entry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, text, target }) });
  const { shown } = await m.phone.handleSignRequest({ approve: true });
  console.log("  phone displayed:", JSON.stringify(shown).slice(0, 160));
  s = await poll(`${RP}/api/sessions/${id}`, (x) => !!x.last);
  if (s.last.decision !== "accept") throw new Error(`gate rejected at ${s.last.failed}`);
  return s.last.record;
}

const strengthOf = async (said: string) => ((await (await fetch(`${RP}/api/strengths`)).json()) as any[]).find((r) => r.said === said);

async function main() {
  installAsciiJsonBodies();
  const a = await enrol("Ana"), b = await enrol("Bo");
  const claim = await postEntry(a, "claim", "Tap water here is safe to drink — naïve? 日本語 ✓");
  console.log("A's claim:", (await strengthOf(claim)).display);
  await postEntry(b, "attack", "The 2025 report found lead above the limit.", claim);
  const after = await strengthOf(claim);
  console.log("after B's attack:", after.display, `(exactly ${after.strength})`);
  if (after.strength !== "1/4") throw new Error("A's claim did not weaken to 1/4");
  const out = process.env.EXPORT_TO ?? "export.json";
  writeFileSync(out, await (await fetch(`${RP}/export.json`)).text());
  const issuer = (await (await fetch(`${ISSUER}/registry`)).json()).issuer;
  console.log(`\nexport written to ${out}. Third person:\n  cd verifier && python -m arglog_verifier ../${out} --issuer ${issuer}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e); process.exit(1); });
