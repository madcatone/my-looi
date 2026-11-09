import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 159);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 159);

// Regression: by user decision (2026-11-09), realtime wheel commands are
// STRICTLY keyword-gated again. v2.1.154 (addressless verb-led imperatives)
// and v2.1.158 (tolerate one unrecognized leading word) were reverted: without
// an accepted robot address at utterance start, nothing triggers and the
// utterance goes to the cloud model. A command hit is still executed and
// acknowledged entirely locally (response.cancel suppresses the model).
// The address alias family — the keyword — keeps every observed Gemini
// transcription variant (louie/louis/lewis/loui/looey/look/lou/luke/blue
// eye/zoe/dui) so "LOOI, …" works despite the transcription roulette.

const parser = read("src/voice/explicit-robot-command.ts");
const helper = read("src/voice/realtime-physical-command.ts");

// 1. The addressless session parser is gone.
assert.ok(!parser.includes("parseSessionRobotCommand"), "addressless session parser must not exist");
assert.ok(!parser.includes("matchSessionImperative"), "session imperative grammar must not exist");
assert.ok(!helper.includes("parseSessionRobotCommand"), "realtime routing must not fall back to a session parser");

// 2. Realtime routing is: emergency stop → addressed parser, nothing else.
assert.match(helper, /if \(containsEmergencyStopWord\(transcript, config\)\) return \{ kind: "emergency-stop" \};/);
assert.match(helper, /const command = parseExplicitRobotCommand\(transcript, config\);/);

// 3. The keyword family includes every observed transcription variant.
for (const alias of ['"louie"', '"louis"', '"lewis"', '"loui"', '"looey"', '"look"', '"lou"', '"luke"', '"blue eye"', '"zoe"', '"dui"']) {
  assert.ok(parser.includes(alias), `BUILTIN_ADDRESS_ALIASES must include ${alias}`);
}

// 4. The addressed contract is intact: address at utterance start, longest
//    alias wins, politeness lead-ins stripped (v2.1.156 keeps working).
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("|пожалуйста|please|okay|ok)\\s+"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 5. Chain hygiene: the reverted tests are out, this test is in, no stray quotes.
assert.ok(!pkg.scripts.test.includes("v2.1.154-session-command"), "reverted 154 test must not be in the chain");
assert.ok(!pkg.scripts.test.includes("v2.1.158-tolerant"), "reverted 158 test must not be in the chain");
assert.ok(pkg.scripts.test.includes("v2.1.159-strict-address-gate-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.159 strict address gate regression: PASS");
