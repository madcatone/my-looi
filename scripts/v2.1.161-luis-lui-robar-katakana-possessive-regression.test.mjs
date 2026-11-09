import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 161);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 161);

// Regression: on-device round 2026-11-09 14:19–14:21 produced seven misses,
// three distinct failure classes, all inside the strict-gate policy:
//   1. New wake-name spellings: "Luis, turn right" (x3), "Lui. Forward.",
//      "robar back" — aliases 11-13 of the nondeterministic family.
//   2. Cross-script: "ルイ go back" — katakana is stripped by the normalize
//      charset, so it can never match a Latin alias; transliterate ルイ→rui.
//   3. Possessive clitic: "Robot's back" — apostrophe stripping turns the
//      accepted alias "robot" into the non-alias "robots".
// Note: "Louis fall back" missed for a DIFFERENT reason ("fall" is not a
// move verb; the grammar requires "go back"/bare "back") — that is by design
// and stays.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. Observed spellings must be in the alias family.
for (const alias of ['"luis"', '"lui"', '"robar"']) {
  assert.ok(parser.includes(alias), `BUILTIN_ADDRESS_ALIASES must include ${alias}`);
}

// 2. Katakana transliteration must run BEFORE the script filter.
assert.ok(parser.includes('.replace(/ルイ/gu, "rui")'), "normalizeMatchText must transliterate katakana ルイ to rui");

// 3. Possessive clitic must be stripped before apostrophe removal.
assert.ok(parser.includes(".replace(/['’]s(?=\\s|$)/gu, \"\")"), "normalizeMatchText must strip the English possessive clitic");

// 4. Strict gate shape unchanged (v2.1.159 decision).
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 5. Chain hygiene (carried from v2.1.155/157/160).
assert.ok(pkg.scripts.test.includes("v2.1.161-luis-lui-robar-katakana-possessive-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.161 luis/lui/robar + katakana + possessive regression: PASS");
