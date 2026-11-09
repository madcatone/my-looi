import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 158);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 158);

// Regression: the wake-name transcription roulette is unending — after nine
// enumerated variants (louie, louis, look, lewis, lou, luke, blue eye, zoe,
// dui), on-device logs kept showing the same miss shape: one unrecognized
// leading word + an otherwise valid verb-led imperative ("Zoe go back",
// "Dui, go back."). v2.1.158 makes the in-session parser tolerate exactly
// ONE unrecognized leading word when the remainder is an exact session
// imperative. The full-utterance grammar stays the safety net:
//   - "honey go back to sleep" (extra words after the imperative) still misses
//   - "Zoe 180" / "Zoe right" (no verb / bare direction) still miss
//   - only one word is stripped: "the dogs turn left" still misses

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The session parser must try the exact imperative first, then retry once
//    with a single leading word dropped.
assert.ok(
  parser.includes("const parsed = matchSessionImperative(command);"),
  "session parser must first try the exact imperative"
);
assert.ok(
  parser.includes("if (parsed) return parsed;"),
  "exact imperative match wins before tolerant retry"
);
assert.ok(
  parser.includes('const rest = command.slice(command.indexOf(" ") + 1);'),
  "tolerant retry must strip exactly one leading word"
);
assert.ok(
  parser.includes("if (rest && rest !== command) return matchSessionImperative(rest);"),
  "tolerant retry must re-use the same anchored grammar"
);

// 2. The imperative grammar itself stays fully anchored (no new loose forms).
const sessionStart = parser.indexOf("function matchSessionImperative");
const sessionEnd = parser.indexOf("function parseRequestedNodCount");
const sessionBody = parser.slice(sessionStart, sessionEnd);
for (const sourceFragment of [
  "^(?:turn|rotate|spin)\\s+(?:left|right)(?:\\s+please)?$",
  "^(?:turn|rotate|spin)\\s+(?:180|one\\s+eighty|one\\s+hundred(?:\\s+and)?\\s+eighty)(?:\\s+degrees?)?(?:\\s+please)?$",
  "^(?:go|drive|move)\\s+(?:forward|ahead|straight)(?:\\s+please)?$",
  "^(?:go|drive|move|come)\\s+(?:back|backward|reverse)(?:\\s+please)?$",
]) {
  assert.ok(sessionBody.includes(sourceFragment), `imperative clause missing or unanchored: ${sourceFragment}`);
}
assert.ok(!sessionBody.includes("isBareDirectionCommand"), "imperative grammar must not accept bare direction words");

// 3. Addressed parsing contract unchanged.
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));

// 4. Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.158-tolerant-session-address-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.158 tolerant session address regression: PASS");
