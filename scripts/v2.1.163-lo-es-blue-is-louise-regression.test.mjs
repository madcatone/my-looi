import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 163);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 163);

// Regression: on-device round 2026-11-09 14:29–14:35 produced six new
// wake-name variants. v2.1.162 fixed the class (NFD diacritic fold → "Luís"
// works) plus ruin/robots; this test pins the remaining three observed
// spellings:
//   "lo es turn left"   — Spanish segmentation of the spoken name
//   "blue is turn left" — "blue eyes"/"blue is" merge
//   "Louise back"       — feminine French spelling
// ("lui va" also missed, but "va" is a French verb — a grammar gap, by
// design until FR support is requested, not an alias gap.)
//
// Safety unchanged: aliases are honored only in the address position and the
// remainder must parse as a deterministic physical command.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The three observed spellings must be in the alias family.
for (const alias of ['"lo es"', '"blue is"', '"louise"']) {
  assert.ok(parser.includes(alias), `BUILTIN_ADDRESS_ALIASES must include ${alias}`);
}

// 2. v2.1.162's class fixes must still be present.
assert.ok(parser.includes('"ruin"'), "ruin alias must stay");
assert.ok(parser.includes('"robots"'), "robots alias must stay");
assert.ok(parser.includes('.normalize("NFD").replace(/[\\u0300-\\u036f]/gu, "")'), "NFD diacritic fold must stay");

// 3. Strict gate shape (v2.1.159 decision) unchanged.
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 4. Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.163-lo-es-blue-is-louise-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.163 lo es / blue is / louise regression: PASS");
