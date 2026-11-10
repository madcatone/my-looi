import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 169);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 169);

// 2026-11-10 on-device observation: "blue look here" missed the address gate —
// Gemini transcribed the wake name as bare "blue" (the family knew blue eye /
// blue is / blue east but not the bare form). User approved adding it.
// The matcher sorts aliases longest-first, so the longer blue-family entries
// still win for "blue eye go forward" etc.; bare "blue" only fires when the
// longer forms do not match.
const parser = read("src/voice/explicit-robot-command.ts");
assert.ok(parser.includes('"blue eye", "zoe"'), "blue eye must stay");
assert.ok(parser.includes('"blue is"'), "blue is must stay");
assert.ok(parser.includes('"blue east", "blue"'), "bare blue must join the blue family");
assert.ok(parser.indexOf('"blue"') > parser.indexOf('"blue eye"'), "blue must come after the longer forms in the literal");

// Behavioral check with the compiled parser.
const outDir = "/tmp/erc169";
fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/voice/explicit-robot-command.ts",
    "--outDir", outDir,
    "--module", "commonjs",
    "--target", "es2020",
    "--skipLibCheck",
    "--ignoreConfig",
  ],
  { stdio: "pipe" }
);
const { parseExplicitRobotCommand } = await import(`${outDir}/voice/explicit-robot-command.js`);
const prefs = {
  robotName: "LOOI",
  robotAddressAliases: [],
  robotAddressRecognitionAliases: [],
  listeningLanguage: "en",
  customVoiceCommands: {},
};

// Bare blue now works for physical commands.
assert.equal(parseExplicitRobotCommand("blue go forward", prefs)?.direction, "forward");
assert.equal(parseExplicitRobotCommand("blue, turn left", prefs)?.direction, "left");

// The longer blue family still wins — bare blue must not shadow them.
assert.equal(parseExplicitRobotCommand("blue eye go forward", prefs)?.direction, "forward");
assert.equal(parseExplicitRobotCommand("blue east turn right", prefs)?.direction, "right");

// Bare blue resolves the observed miss: the visual parser (which reuses this
// gate) accepts "blue look here" now. Verify through the composed parser.
const visualSrc = "src/voice/realtime-visual-command.ts";
const outDir2 = "/tmp/erc169v";
fs.rmSync(outDir2, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/voice/realtime-visual-command.ts",
    "--outDir", outDir2,
    "--module", "commonjs",
    "--target", "es2020",
    "--skipLibCheck",
    "--ignoreConfig",
  ],
  { stdio: "pipe" }
);
const { parseRealtimeVisualCommand } = await import(`${outDir2}/voice/realtime-visual-command.js`);
assert.deepEqual(
  parseRealtimeVisualCommand("blue look here", prefs),
  { kind: "look-here", cameraFacing: "front" },
  "the observed on-device miss 'blue look here' must now parse"
);
assert.equal(
  parseRealtimeVisualCommand("blue is looking great today", prefs),
  null,
  "blue is (an alias) followed by non-command chatter must still go to the cloud"
);

// Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.169-blue-address-alias-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.169 bare blue address alias: PASS");
