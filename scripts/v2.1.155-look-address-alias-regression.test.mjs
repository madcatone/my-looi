import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 155);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 155);

// Regression: Gemini Live transcribes the wake name nondeterministically
// across the /lu/-initial word family. On-device logs for the SAME utterance
// "LOOI, forward" produced "Louis, go forward." (intercepted), "Look.
// Forward." (missed) and "Lewis, go forward." (missed). Each unseen spelling
// silently fails the address gate and the command falls to the LLM ("I can
// only chat"). v2.1.155 adds the observed variants look/lewis plus the
// remaining phonetic siblings lou/luke.
//
// Safety unchanged: aliases are accepted only in the address position and the
// remainder must still parse as a deterministic physical command. "look"
// coexists with the visual look-here grammar because physical interception
// runs first but only consumes utterances whose remainder is a physical
// command — "look here"/"look at this" still reach the visual parser.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. Observed + phonetic-sibling address variants must stay in the family.
for (const alias of ['"look"', '"lewis"', '"lou"', '"luke"']) {
  assert.ok(parser.includes(alias), `BUILTIN_ADDRESS_ALIASES must include ${alias}`);
}

// 2. The safety shape is unchanged: address still required at utterance start,
//    emergency stop still global. (The in-session parser this test once also
//    asserted was reverted by design in v2.1.159; the strict gate is guarded
//    by v2.1.159-strict-address-gate-regression.test.mjs.)
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 3. The npm test chain tail must stay valid shell: previous sed appends had
//    embedded an escaped quote into the JSON string value, leaving shell
//    commands like `node scripts/x.test.mjs"` (module not found). The chain
//    must not contain any stray quote inside a filename.
assert.ok(!pkg.scripts.test.includes('.test.mjs\\"'), "test chain must not contain escaped quotes inside commands");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}
assert.ok(pkg.scripts.test.includes("v2.1.155-look-address-alias-regression.test.mjs"), "this test must be part of the npm test chain");

console.log("v2.1.155 look/lewis address alias regression: PASS");
