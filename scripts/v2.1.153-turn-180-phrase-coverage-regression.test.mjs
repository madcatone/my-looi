import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 153);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 153);

// Regression: in a Realtime voice session the ONLY path to the wheels is the
// deterministic parser (realtime-pcm-conversation.ts -> parseRealtimePhysicalCommand
// -> parseExplicitRobotCommand). Anything it misses falls through to the LLM,
// whose system prompt correctly says it has no movement tool — the user hears
// "I can only chat". On the Gemini provider, two gaps made "turn 180 degrees"
// miss where the OpenAI path (whose STT biasing pulls the address back to
// "LOOI") hit:
//   1. Address aliases lacked English transcription variants of the wake name
//      (Gemini has no STT biasing equivalent; "Louie" was common).
//   2. The 180° number-word list only had "one eighty"; Gemini transcribes
//      spoken numbers as "one hundred (and) eighty".

const parser = read("src/voice/explicit-robot-command.ts");

// 1. Address aliases must include the English wake-name family
//    (mirrors wake-phrases.ts which already treats louie/loui as wake words).
for (const alias of ['"looi"', '"louie"', '"loui"', '"looey"']) {
  assert.ok(parser.includes(alias), `BUILTIN_ADDRESS_ALIASES must include ${alias}`);
}
// The glued-address splitter must know the same family.
assert.ok(parser.includes("|looi|louie|louis|loui|looey)(?="), "glued-address splitter must include the English wake-name family");

// 2. 180° word forms must cover "one hundred (and) eighty" with optional degrees,
//    and every pre-existing form must survive.
for (const fragment of [
  "turn\\s+around",
  "turn\\s+back\\s+around",
  "u\\s*turn",
  "one\\s+eighty",
  "one\\s+hundred(?:\\s+and)?\\s+eighty",
  "180",
]) {
  assert.ok(parser.includes(fragment), `180 command list must contain ${fragment}`);
}

// 3. Safety shape must be unchanged: commands still REQUIRE an address at
//    utterance start, and emergency stop stays global.
assert.ok(parser.includes("if (normalized === address) return null;"));
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

console.log("v2.1.153 turn-180 phrase coverage regression: PASS");
