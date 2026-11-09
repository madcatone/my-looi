import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 165);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 165);

// Regression: on-device 2026-11-09 15:05–15:07 (app v2.1.164) produced two
// distinct miss classes, both inside the strict-gate policy:
//   1. Wake-name spelling: "Blue East turn left" — "blue eye"/"blue is" were
//      already aliases (one transcription family); this is the third member.
//      Enumerated individually, no prefix wildcard, per the v2.1.159 policy.
//   2. Verb tense: "Lewis turned left." and "Louise turned left." — the
//      address matched, but MOVE_VERB_RE only had base forms
//      (go/drive/move/turn), so past-tense "turned" fell through. STT
//      roulette now hits the verb too; past/-s/-ing forms join the base
//      forms, plus irregular pasts "went"/"drove".

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The observed spelling must be in the alias family.
assert.ok(parser.includes('"blue east"'), "BUILTIN_ADDRESS_ALIASES must include blue east");

// 2. Verb inflections must be accepted (observed: "turned"; siblings follow
//    the same inflection family; "went"/"drove" are irregular pasts).
assert.ok(parser.includes("turn(?:ed|s|ing)?"), "MOVE_VERB_RE must accept turn inflections");
assert.ok(parser.includes("go(?:es|ing)?"), "MOVE_VERB_RE must accept go inflections");
assert.ok(parser.includes("went"), "MOVE_VERB_RE must accept went (past of go)");
assert.ok(parser.includes("move(?:d|s|ing)?"), "MOVE_VERB_RE must accept move inflections");
assert.ok(parser.includes("drive(?:n|s|ing)?"), "MOVE_VERB_RE must accept drive inflections");
assert.ok(parser.includes("drove"), "MOVE_VERB_RE must accept drove (past of drive)");

// 3. The 180° grammar must accept inflected "turned around" too.
assert.ok(
  parser.includes("turn(?:ed|s|ing)?\\s+around"),
  "the 180-degree grammar must accept turn inflections"
);

// 4. Strict gate shape unchanged (v2.1.159 decision).
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 5. Chain hygiene (carried from v2.1.155/157/160/161/162/163/164).
assert.ok(pkg.scripts.test.includes("v2.1.165-blue-east-verb-tense-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.165 blue east + verb tense regression: PASS");
