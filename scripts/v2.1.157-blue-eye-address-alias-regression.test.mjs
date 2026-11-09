import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 157);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 157);

// Regression: on-device log 2026-11-05 15:12:09 — spoken "LOOI turn left"
// transcribed by Gemini Live as "blue eye turn left" and missed the address
// gate (physical=miss, command fell to the LLM). Another member of the
// nondeterministic /lu/-initial transcription family (louie/louis/look/
// lewis/lou/luke were already covered). v2.1.157 adds the two-word alias
// "blue eye" (the alias list already had a two-word precedent: "лу и").
//
// Safety unchanged: aliases are honored only in the address position and the
// remainder must still parse as a deterministic physical command — "my blue
// eye hurts" fails the address-at-start gate entirely.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The observed variant must be in the alias family.
assert.ok(parser.includes('"blue eye"'), "BUILTIN_ADDRESS_ALIASES must include blue eye");

// 2. The safety shape is unchanged.
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));
assert.ok(parser.includes("export function parseSessionRobotCommand"));

// 3. Chain hygiene (carried from v2.1.155): this test must be in the chain,
//    and the chain must not contain stray quotes inside commands.
assert.ok(pkg.scripts.test.includes("v2.1.157-blue-eye-address-alias-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.157 blue eye address alias regression: PASS");
