// Computes the self-addressing identifiers (SAIDs) for the credential
// schema and writes the result to schema/<SAID>.json.
//
//   npx tsx schema/saidify.ts
//
// The attributes block is SAIDified first, then the whole schema, the
// same order the vLEI schemas use. Rerun after ANY edit to the source:
// a changed schema is a different schema, with a different SAID.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import signify from "signify-ts";

const { Saider, ready, MtrDex, Serials } = signify;
const here = __dirname;

async function main() {
  await ready();
  const schema = JSON.parse(
    readFileSync(join(here, "foundational-credential.source.json"), "utf8")
  );

  const attrs = schema.properties.a.oneOf[1];
  const [, attrsSad] = Saider.saidify(attrs, MtrDex.Blake3_256, Serials.JSON, "$id");
  schema.properties.a.oneOf[1] = attrsSad;

  const [saider, sad] = Saider.saidify(schema, MtrDex.Blake3_256, Serials.JSON, "$id");

  for (const f of readdirSync(here)) {
    if (/^E[A-Za-z0-9_-]{43}\.json$/.test(f)) unlinkSync(join(here, f));
  }
  // Compact JSON: the bytes served must hash to the SAID.
  writeFileSync(join(here, `${saider.qb64}.json`), JSON.stringify(sad));
  writeFileSync(join(here, "SAID"), saider.qb64 + "\n");
  console.log(saider.qb64);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
