// RUNBOOK drill, stand-in form. The wallet's recovery (agent.ts
// recoverKeriaAgent) turns the recovery phrase back into the 21-character
// passcode, builds a SignifyClient on the connect URL and calls connect():
// no boot, no new agent. This does the same with a Signify client: make an
// identifier, throw the client away, come back with only the passcode.
// It is NOT a phone restoring from its phrase; that drill is still owed.
import signify from "signify-ts";
import { connect, installAsciiJsonBodies, toadFor, waitOp, witnessAidsFromAgentConfig } from "../common/src";
const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
async function main() {
  await signify.ready(); installAsciiJsonBodies();
  const bran = signify.randomPasscode();           // stays in this process; never printed
  let c = await connect(KERIA, bran);
  const wits = await witnessAidsFromAgentConfig(c);
  await waitOp(c, await (await c.identifiers().create("holder", { wits, toad: toadFor(wits.length) })).op());
  const before = (await c.identifiers().get("holder")).prefix;
  await waitOp(c, await (await c.identifiers().interact("holder", { d: before })).op());
  c = undefined as any;

  const again = new signify.SignifyClient(KERIA.url, bran, signify.Tier.low, "");   // as the wallet: no boot URL
  await again.connect();
  const hab = await again.identifiers().get("holder");
  console.log("same identifier after recovery:", hab.prefix === before, hab.prefix);
  const ixn = await again.identifiers().interact("holder", { d: before });
  await waitOp(again, await ixn.op());
  console.log("recovered client can sign: event", ixn.serder.ked.s, "accepted and witnessed");
  const stranger = new signify.SignifyClient(KERIA.url, signify.randomPasscode(), signify.Tier.low, "");
  console.log("a wrong phrase:", await stranger.connect().then(() => "connected?!", (e) => `refused (${String(e.message).slice(0, 60)})`));
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
