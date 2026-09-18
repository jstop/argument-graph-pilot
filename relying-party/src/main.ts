// Entry point: tsx relying-party/src/main.ts
import { join, resolve } from "node:path";
import { requireEnv } from "@pilot/common";
import { RelyingParty } from "./core";
import { buildServer } from "./server";

async function main() {
  const schemaSaid = requireEnv("SCHEMA_SAID");
  const publicUrl = requireEnv("RP_PUBLIC_URL").replace(/\/+$/, "");
  const rp = new RelyingParty({
    keria: { url: requireEnv("KERIA_URL", "http://127.0.0.1:3901"), bootUrl: requireEnv("KERIA_BOOT_URL", "http://127.0.0.1:3903") },
    dataDir: resolve(requireEnv("RP_DATA_DIR", "./data/relying-party")),
    displayName: requireEnv("RP_DISPLAY_NAME", "Argument Log"),
    community: requireEnv("COMMUNITY_NAME", "Pilot community"),
    publicUrl,
    schemaDir: resolve(requireEnv("SCHEMA_DIR", join(__dirname, "../../schema"))),
    trustedIssuerAid: requireEnv("TRUSTED_ISSUER_AID"),
    trustedIssuerOobi: requireEnv("TRUSTED_ISSUER_OOBI"),
    issuerUrl: requireEnv("ISSUER_URL").replace(/\/+$/, ""),
    schemaSaid,
    schemaOobi: `${publicUrl}/oobi/${schemaSaid}`,
    sessionTtlMs: Number(requireEnv("SESSION_TTL_SECONDS", "1800")) * 1000,
    maxTextLength: Number(requireEnv("MAX_TEXT_LENGTH", "500")),
  });
  const log = (m: string) => console.log(`[relying-party] ${m}`);
  const port = Number(requireEnv("RP_PORT", "3120"));
  // Listen first: during init KERIA fetches the schema from this server (demo2 finding).
  const server = buildServer(rp);
  await new Promise<void>((r) => server.listen(port, r));
  log(`listening on :${port}`);
  await rp.init(log);

  let busy = false, n = 0;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await rp.tick();
      if (++n % 20 === 0) await rp.refreshIssuer(); // so the page reflects revocations and checkpoints within ~30 s
    } catch (e) { console.error("[relying-party] tick failed:", e); } finally { busy = false; }
  }, 1500);
}

main().catch((e) => { console.error(`[relying-party] fatal: ${e instanceof Error ? e.message : e}`); process.exit(1); });
