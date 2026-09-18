// RUNBOOK drill, against the RUNNING containers: a member posts, the
// operator revokes them with the real CLI inside the issuer container
// (which seals the log head in the issuer's KEL first), the member's key
// still works and they try again. Then the export is downloaded.
//   OPERATOR_TOKEN=... npx tsx spike/13-revocation-drill.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installAsciiJsonBodies } from "../common/src";
import { WalletStandIn } from "../common/src/testing/wallet-standin";

const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
const ISSUER = "http://127.0.0.1:3110", RP = "http://127.0.0.1:3120";
if (!process.env.OPERATOR_TOKEN) { console.error("set OPERATOR_TOKEN (from infra/services.env)"); process.exit(2); }
const AUTH = { Authorization: "Basic " + Buffer.from(`operator:${process.env.OPERATOR_TOKEN}`).toString("base64") };
process.env.STANDIN_URL_REWRITES = "http://arglog-issuer:3110=http://127.0.0.1:3110,http://arglog-log:3120=http://127.0.0.1:3120";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(url: string, until: (s: any) => boolean, headers = {}, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const s = await (await fetch(url, { headers })).json(); if (until(s)) return s; await sleep(1000); }
  throw new Error(`timeout polling ${url}`);
}

async function main() {
  installAsciiJsonBodies();
  const log: any[] = await (await fetch(`${RP}/log.json`)).json();
  const claim = log.find((r) => r.payload.kind === "claim");
  if (!claim) throw new Error("run spike/12 first: the log has no claim to respond to");

  const phone = await WalletStandIn.create(KERIA, "Rex");
  let s = await (await fetch(`${ISSUER}/api/sessions`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ handle: "Rex" }) })).json();
  const issuerOobi = s.qrUrl.split("?")[0];
  await phone.scan(s.qrUrl);
  await poll(`${ISSUER}/api/sessions/${s.id}`, (x) => x.state === "granted", AUTH);
  const said = await phone.acceptCredential(issuerOobi);
  console.log("Rex", phone.aid, "membership", said);

  const start = await fetch(`${RP}/start?kind=support&target=${claim.d}`, { redirect: "manual" });
  const id = start.headers.get("location")!.split("/s/")[1].split("?")[0];
  s = await (await fetch(`${RP}/api/sessions/${id}`)).json();
  await phone.scan(s.qrUrl);
  await poll(`${RP}/api/sessions/${id}`, (x) => x.state === "requesting");
  const p = phone.present(said);
  await poll(`${RP}/api/sessions/${id}`, (x) => x.state === "verified"); await p;
  const post = async (kind: string, text: string) => {
    await fetch(`${RP}/api/sessions/${id}/entry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, text, target: claim.d }) });
    await phone.handleSignRequest({ approve: true });
    return (await poll(`${RP}/api/sessions/${id}`, (x) => !!x.last)).last;
  };
  const early = await post("support", "I drink it daily.");
  console.log("before revocation:", early.decision, early.record);
  const strength = async () => ((await (await fetch(`${RP}/api/strengths`)).json()) as any[]).find((r) => r.said === claim.d).strength;
  const before = await strength();

  console.log("\n$ main.ts revoke", said);
  console.log(execFileSync("docker", ["compose", "--env-file", "infra/services.env", "-f", "infra/compose.services.yaml", "exec", "-T", "arglog-issuer", "npx", "tsx", "issuer/src/main.ts", "revoke", said],
    { cwd: join(__dirname, ".."), encoding: "utf8" }).split("\n").filter((l) => l.includes("[issuer]")).join("\n"));

  const late = await post("attack", "Posted after my membership was revoked.");
  console.log("after revocation:", late.decision, "at check", late.failed, "—", late.checks[late.checks.length - 1].detail);
  console.log("claim strength before/after:", before, await strength());
  writeFileSync(process.env.EXPORT_TO ?? "export.json", await (await fetch(`${RP}/export.json`)).text());
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e); process.exit(1); });
