import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 160);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 160);

// Regression: on-device log 2026-11-09 14:13:31 — spoken "LOOI, turn left"
// transcribed by Gemini Live as "Rui, turn left." and missed the address gate
// (physical=miss). Tenth observed member of the nondeterministic wake-name
// transcription family (louie/louis/look/lewis/lou/luke/blue eye/zoe/dui were
// already covered). User decision 2026-11-09 (v2.1.159): keep the strict
// address gate and enumerate observed variants — so variant ten goes into the
// alias family like the nine before it.
//
// Safety unchanged: aliases are honored only in the address position and the
// remainder must still parse as a deterministic physical command — "Rui is my
// friend" fails the address-at-start gate entirely.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The observed variant must be in the alias family.
assert.ok(parser.includes('"rui"'), "BUILTIN_ADDRESS_ALIASES must include rui");

// 2. The strict gate shape is unchanged (v2.1.159): address at utterance
//    start is mandatory for wheel commands; emergency stop stays global.
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 3. Chain hygiene (carried from v2.1.155/157): this test must be in the
//    chain, and the chain must not contain stray quotes inside commands.
assert.ok(pkg.scripts.test.includes("v2.1.160-rui-address-alias-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.160 rui address alias regression: PASS");
