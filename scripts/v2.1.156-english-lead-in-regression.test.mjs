import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 156);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 156);

// Regression: docs/voice-commands.md claimed polite lead-ins after the address
// are ignored, but stripNaturalCommandLeadIns only stripped Russian fillers —
// "LOOI, please forward" (politeness + bare direction) silently missed the
// parser and fell to the LLM, while "LOOI, please go forward" worked only
// because the verb path searches the whole utterance. A fresh-context doc
// read-back caught the claim/reality gap. v2.1.156 strips the English
// politeness family the same way as the Russian one.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. The English lead-in family must be stripped after a valid address.
assert.ok(
  parser.includes("|пожалуйста|please|okay|ok)\\s+"),
  "stripNaturalCommandLeadIns must strip please/okay/ok alongside the Russian fillers"
);

// 2. Ordering inside the alternation must not let "ok" eat "okay":
//    "okay" is listed before "ok".
assert.ok(
  parser.includes("please|okay|ok)"),
  "alternation must list okay before ok so a longer word is not truncated"
);

// 3. Lead-in stripping stays bounded (address-at-start still mandatory,
//    emergency stop still global). (The in-session parser this test once also
//    asserted was reverted by design in v2.1.159.)
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));
assert.ok(parser.includes("for (let i = 0; i < 3; i += 1)"), "lead-in loop stays capped at 3 strips");

console.log("v2.1.156 English lead-in regression: PASS");
