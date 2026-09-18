import assert from "node:assert/strict";
import { test } from "node:test";
import { HandleError, parseHandle, parseSessionInput } from "../src/handle";

const ch = (...codes: number[]) => String.fromCodePoint(...codes);
const NON_ASCII = `Zo${ch(0xeb)} ${ch(0x65e5, 0x672c)}`; // Zoe-with-diaeresis, space, "Japan" in kanji
const EMOJI = ch(0x1f600);

test("accepts ordinary and non-ASCII handles, trimmed", () => {
  assert.equal(parseHandle("alice"), "alice");
  assert.equal(parseHandle("  alice b  "), "alice b");
  assert.equal(parseHandle(NON_ASCII), NON_ASCII);
  assert.equal(parseHandle("x".repeat(40)), "x".repeat(40));
  // length is counted in code points, as the schema's maxLength is
  assert.equal(parseHandle(EMOJI.repeat(40)), EMOJI.repeat(40));
});

test("rejects empty, too long, non-strings and control characters", () => {
  const control = [0x00, 0x0a, 0x1b, 0x7f, 0x85, 0x2028, 0x2029, 0x202e].map((c) => `a${ch(c)}b`);
  const loneSurrogate = "a" + String.fromCharCode(0xd800) + "b";
  for (const bad of ["", "   ", ch(0x09, 0x0a), "x".repeat(41), EMOJI.repeat(41), ...control, loneSurrogate, 7, null, undefined, {}, ["alice"]]) {
    assert.throws(() => parseHandle(bad), HandleError, JSON.stringify(bad));
  }
});

test("session input is exactly {handle}: no scores, roles or anything else", () => {
  assert.equal(parseSessionInput({ handle: " bob " }), "bob");
  for (const bad of [null, "bob", [], {}, { handle: "bob", role: "admin" }, { handle: "bob", score_1: 7 }, { handle: 5 }]) {
    assert.throws(() => parseSessionInput(bad), HandleError, JSON.stringify(bad));
  }
});
