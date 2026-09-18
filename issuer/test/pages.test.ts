// The pages are template literals; an escape like "\n" inside one becomes a
// real newline in the served script and the whole script stops parsing
// (found by the first person to use the deployed operator page: no QR, the
// form fell back to a plain GET). Every inline script we serve must parse.
import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorPage } from "../src/ui";
import { sessionPage } from "../../relying-party/src/ui";

for (const [name, html] of Object.entries({ "operator page": operatorPage(), "session page": sessionPage("0".repeat(32), "attack", undefined, 500) })) {
  test(`${name}: inline script parses`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const m of scripts) assert.doesNotThrow(() => new Function(`return async () => {${m[1]}}`));
  });
}
