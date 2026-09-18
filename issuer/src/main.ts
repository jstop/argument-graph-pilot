// Entry point.
//   tsx issuer/src/main.ts            serve (first run performs the inception ceremony)
//   tsx issuer/src/main.ts status     print the issuer's key state and exit
//   tsx issuer/src/main.ts rotate     rotate the issuer's signing key and exit
//   tsx issuer/src/main.ts checkpoint anchor the relying party's current log head in the issuer's KEL
//   tsx issuer/src/main.ts revoke <credential SAID> [--no-checkpoint]
//                                     checkpoint the log, then revoke; refuses if LOG_URL/log/head is unreachable
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { requireEnv } from "@pilot/common";
import { Issuer, type IssuerConfig } from "./core";
import { buildServer } from "./server";

function config(): IssuerConfig {
  return {
    keria: {
      url: requireEnv("KERIA_URL", "http://127.0.0.1:3901"),
      bootUrl: requireEnv("KERIA_BOOT_URL", "http://127.0.0.1:3903"),
    },
    publicUrl: requireEnv("ISSUER_PUBLIC_URL").replace(/\/+$/, ""),
    dataDir: resolve(requireEnv("ISSUER_DATA_DIR", "./data/issuer")),
    displayName: requireEnv("ISSUER_DISPLAY_NAME", "Community Issuer"),
    schemaDir: resolve(requireEnv("SCHEMA_DIR", join(__dirname, "../../schema"))),
    sessionTtlMs: Number(requireEnv("SESSION_TTL_SECONDS", "900")) * 1000,
    logUrl: process.env.LOG_URL || undefined,
  };
}

async function main() {
  const command = process.argv[2] ?? "serve";
  const issuer = new Issuer(config());
  const log = (m: string) => console.log(`[issuer] ${m}`);

  if (command === "serve") {
    const token = requireEnv("OPERATOR_TOKEN");
    if (token.length < 16) throw new Error("OPERATOR_TOKEN must be at least 16 characters");
    const port = Number(requireEnv("ISSUER_PORT", "3110"));
    // Listen first: during init KERIA fetches the schema from this server.
    const wallet = process.env.WALLET_BOOT_URL && process.env.WALLET_CONNECT_URL
      ? { bootUrl: process.env.WALLET_BOOT_URL, connectUrl: process.env.WALLET_CONNECT_URL }
      : undefined;
    const server = buildServer({ issuer, operatorToken: token, wallet });
    await new Promise<void>((r) => server.listen(port, r));
    log(`listening on :${port}`);
    await issuer.init(log);
    if (!process.env.LOG_URL) log("LOG_URL is not set: checkpoint and revoke will refuse until it is");
    log(`operator page: http://127.0.0.1:${port}/  (user "operator")`);
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await issuer.tick(); } catch (e) { console.error("[issuer] tick failed:", e); } finally { busy = false; }
    }, 1500);
    return;
  }

  // One-shot commands need the schema reachable too, so they serve it briefly.
  // The operator API is unreachable while they do: nobody knows this token.
  const server = buildServer({ issuer, operatorToken: randomBytes(32).toString("hex") });
  const port = Number(requireEnv("ISSUER_PORT", "3110"));
  const alreadyServing = await new Promise<boolean>((r) => {
    server.once("error", () => r(true)); // port taken: the long-running server is up, fine
    server.listen(port, () => r(false));
  });
  await issuer.init(log);
  if (command === "status") {
    console.log(JSON.stringify(await issuer.keyState(), null, 2));
  } else if (command === "rotate") {
    const before = await issuer.keyState();
    const sn = await issuer.rotate();
    const after = await issuer.keyState();
    log(`rotated: event ${before.sn} -> ${sn}`);
    log(`previously committed next key is now the signing key; new commitment: ${after.nextKeyDigests.join(", ")}`);
  } else if (command === "checkpoint") {
    const { head, sn } = await issuer.checkpointCurrentHead();
    log(`checkpoint: log head ${head.d} (entry ${head.n}) anchored at issuer event ${sn}`);
  } else if (command === "revoke") {
    const args = process.argv.slice(3);
    const said = args.find((a) => !a.startsWith("--"));
    const unknown = args.filter((a) => a.startsWith("--") && a !== "--no-checkpoint");
    if (!said || unknown.length > 0) throw new Error("usage: revoke <credential SAID> [--no-checkpoint]");
    const done = await issuer.revokeAtCurrentHead(said, { noCheckpoint: args.includes("--no-checkpoint") }, (m) => console.warn(`[issuer] ${m}`));
    if (done.head) log(`checkpoint: log head ${done.head.d} (entry ${done.head.n}) anchored at issuer event ${done.checkpointSn}`);
    log(`revoked ${said} at issuer event ${done.revocationSn}`);
  } else {
    throw new Error(`unknown command "${command}" (serve | status | rotate | checkpoint | revoke)`);
  }
  if (!alreadyServing) server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[issuer] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
