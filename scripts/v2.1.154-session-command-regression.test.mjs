import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 154);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 154);

// Regression: on-device Gemini Live logs showed every physical command missing
// interception for one of two address-gate reasons:
//   1. "Louis, turn around." — Gemini transcribes the wake name as "Louis",
//      which was absent from the address alias family.
//   2. "Turn one hundred eighty degrees." / "Go ahead." — the user naturally
//      drops the address mid-session; every addressless command fell through
//      to the LLM, which correctly answered "I can only chat".
// Fix: add the "louis" alias, and inside a live PCM session accept whole-
// utterance verb-led imperatives via parseSessionRobotCommand. Conversation
// text ("let's go forward with the plan") can never match the full-utterance
// grammar; bare directions/numbers stay address-only.

const parser = read("src/voice/explicit-robot-command.ts");
const helper = read("src/voice/realtime-physical-command.ts");

// 1. The "louis" transcription variant must survive in both address lists.
assert.ok(parser.includes('"louis"'), "BUILTIN_ADDRESS_ALIASES must include louis");
assert.ok(
  parser.includes("|looi|louie|louis|loui|looey)(?="),
  "glued-address splitter must include louis BEFORE the shorter loui prefix (regex alternation order)"
);

// 2. The in-session parser must exist and be wired as the address-required
//    parser's fallback inside the realtime entry point only.
assert.match(parser, /export function parseSessionRobotCommand\(text: string, config\?: ExplicitRobotCommandConfig\): ExplicitRobotCommand \| null/);
assert.match(
  helper,
  /parseExplicitRobotCommand\(transcript, config\) \?\? parseSessionRobotCommand\(transcript, config\)/,
  "realtime routing must try the addressed parser first and fall back to the in-session parser"
);

// 3. Safety shape of the in-session parser: every clause is anchored to the
//    full utterance (^...$) and verb-led. Bare directions / bare numbers must
//    NOT be acceptable without an address. Fragments are matched as literal
//    source text exactly as the parser regexes are written.
const sessionStart = parser.indexOf("export function parseSessionRobotCommand");
const sessionEnd = parser.indexOf("function parseRequestedNodCount");
const sessionBody = parser.slice(sessionStart, sessionEnd);
for (const sourceFragment of [
  "^(?:turn|rotate|spin)\\s+(?:left|right)(?:\\s+please)?$",
  "^(?:turn\\s+around|turn\\s+back\\s+around|make\\s+a\\s+u\\s*turn|u\\s*turn)(?:\\s+please)?$",
  "^(?:turn|rotate|spin)\\s+(?:180|one\\s+eighty|one\\s+hundred(?:\\s+and)?\\s+eighty)(?:\\s+degrees?)?(?:\\s+please)?$",
  "^(?:go|drive|move)\\s+(?:forward|ahead|straight)(?:\\s+please)?$",
  "^(?:go|drive|move|come)\\s+(?:back|backward|reverse)(?:\\s+please)?$",
]) {
  assert.ok(sessionBody.includes(sourceFragment), `session parser clause missing or unanchored: ${sourceFragment}`);
}
assert.ok(!sessionBody.includes("isBareDirectionCommand"), "session parser must not accept bare direction words");

// 4. The classic addressed parser keeps its contract: address still required.
assert.ok(parser.includes("export function hasExplicitRobotAddress"));
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));

console.log("v2.1.154 session command regression: PASS");
