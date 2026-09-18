// Repro for a finding from the issuer-restore drill (RUNBOOK): on this
// KERIA fork + signify-ts pair, publishing a location (addLocScheme) is
// refused with  400 "unable to verify end role reply message"  in some
// key-event-log states. This prints which.
import signify, { type SignifyClient } from "signify-ts";
import { connect, installAsciiJsonBodies, toadFor, waitOp, witnessAidsFromAgentConfig } from "../common/src";
const KERIA = { url: "http://127.0.0.1:3901", bootUrl: "http://127.0.0.1:3903" };
let n = 0;
async function fresh(): Promise<[SignifyClient, string]> {
  const c = await connect(KERIA, signify.randomPasscode());
  const wits = await witnessAidsFromAgentConfig(c);
  await waitOp(c, await (await c.identifiers().create("a", { wits, toad: toadFor(wits.length) })).op());
  const pre = (await c.identifiers().get("a")).prefix;
  await waitOp(c, await (await c.identifiers().addEndRole("a", "indexer", pre)).op());
  return [c, pre];
}
const loc = async (c: SignifyClient) => { try { await waitOp(c, await (await c.identifiers().addLocScheme("a", { url: `http://h${++n}.example:1`, scheme: "http" })).op()); return "ok"; } catch (e: any) { return `FAILED: ${e.message}`; } };
const ixn = async (c: SignifyClient, pre: string) => waitOp(c, await (await c.identifiers().interact("a", { d: pre })).op());
const rot = async (c: SignifyClient) => waitOp(c, await (await c.identifiers().rotate("a")).op());
async function main() {
  await signify.ready(); installAsciiJsonBodies();
  let [c, pre] = await fresh();
  console.log("icp                      :", await loc(c));
  await ixn(c, pre); console.log("icp, ixn                 :", await loc(c));
  [c, pre] = await fresh(); await rot(c);
  console.log("icp, rot                 :", await loc(c));
  await ixn(c, pre); console.log("icp, rot, ixn            :", await loc(c));
  await rot(c); console.log("icp, rot, ixn, rot       :", await loc(c));
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
