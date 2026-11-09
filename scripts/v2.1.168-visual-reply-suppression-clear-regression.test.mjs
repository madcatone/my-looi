import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 168);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 168);

// Regression 1: v2.1.164's turn-scoped suppression swallowed the model's
// description of the look-here photo. On device (2026-11-09, v2.1.167) five
// consecutive look-here commands captured and sent the image but produced
// zero audible replies — the flag set when the visual command was parsed
// (it must suppress the model's chat reply to the bare utterance) stayed
// set through the image injection, and every output gate dropped the
// description. The injected image item IS a new user turn; both the success
// and the capture-failure paths must clear the flag before response.create.
const pcm = read("src/voice/realtime-pcm-conversation.ts");
const clears = pcm.match(/this\.suppressModelOutputUntilNextUserTranscript = false;/g) ?? [];
assert.equal(
  clears.length,
  4,
  "suppression must clear in exactly 4 places: session reset, audio transcript, visual success path, visual fallback path"
);
const visualFn = pcm.slice(pcm.indexOf("private async executeLocalVisualCommand"));
assert.ok(
  visualFn.slice(0, visualFn.indexOf("private ", 1)).includes("this.suppressModelOutputUntilNextUserTranscript = false;"),
  "the visual success path inside executeLocalVisualCommand must clear the suppression flag"
);
// The clear must precede the response.create that asks the model to describe
// the image, in BOTH branches.
{
  const body = visualFn.slice(0, visualFn.indexOf("private ", 1));
  for (const send of body.matchAll(/this\.send\(\{\s*type: "response\.create"/g)) {
    const before = body.slice(0, send.index);
    assert.ok(
      before.includes("this.suppressModelOutputUntilNextUserTranscript = false;"),
      "response.create in executeLocalVisualCommand must come after the suppression clear"
    );
  }
}

// Regression 2: "look behind you" defaulted to the FRONT camera — the
// back-camera qualifier only recognized the literal phrases "rear camera" /
// "back camera". Natural English "behind you" must request the back camera.
const visualParser = read("src/voice/realtime-visual-command.ts");
assert.ok(
  visualParser.includes("behind\\s+(?:you|yourself)"),
  "BACK_CAMERA_RE must accept 'behind you' / 'behind yourself'"
);

// Behavioral check: compile the parser and run the real function.
const outDir = "/tmp/erc168";
fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/voice/realtime-visual-command.ts",
    "--outDir", outDir,
    "--module", "commonjs",
    "--target", "es2020",
    "--skipLibCheck",
    "--ignoreConfig",
  ],
  { stdio: "pipe" }
);
const { parseRealtimeVisualCommand } = await import(`${outDir}/voice/realtime-visual-command.js`);
const prefs = {
  robotName: "LOOI",
  robotAddressAliases: [],
  robotAddressRecognitionAliases: [],
  listeningLanguage: "en",
  customVoiceCommands: {},
};
assert.deepEqual(
  parseRealtimeVisualCommand("Lewis, look behind you.", prefs),
  { kind: "look-here", cameraFacing: "back" },
  "'look behind you' must parse as a back-camera look-here"
);
assert.deepEqual(
  parseRealtimeVisualCommand("Lewis, look here.", prefs),
  { kind: "look-here", cameraFacing: "front" },
  "plain 'look here' must stay front-camera"
);
assert.deepEqual(
  parseRealtimeVisualCommand("Lewis, take a photo with your rear camera.", prefs),
  { kind: "look-here", cameraFacing: "back" },
  "literal rear-camera phrasing must keep working"
);
assert.equal(
  parseRealtimeVisualCommand("Tell me a joke.", prefs),
  null,
  "utterances without an address must not parse"
);

// Deliberate source change: refresh the pinned hashes of the conversation
// file in older tests (144 and 151 pin it) and the exact versions in 151.
const pcmHash = crypto.createHash("sha256").update(pcm).digest("hex");
for (const f of [
  "scripts/v2.1.144-character-frame-speech-gender-regression.test.mjs",
  "scripts/v2.1.151-public-release-regression.test.mjs",
]) {
  assert.ok(read(f).includes(pcmHash), `${f} must pin the current conversation-file hash after this deliberate change`);
}

// Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.168-visual-reply-suppression-clear-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.168 visual reply suppression clear + behind-you back camera: PASS");
