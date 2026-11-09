import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 162);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 162);

// Regression: on-device log 2026-11-09 14:29:39 — "Luís, turn right." (accented
// í) missed the address gate because the charset filter replaces í with a
// SPACE, splitting the address into "lu s". The fix is systemic, not another
// enumeration: NFD + combining-mark stripping folds ALL Latin diacritics to
// their base letters before the charset filter, so Luís→luis (existing alias),
// and the whole accented spelling family folds for free.

const parser = read("src/voice/explicit-robot-command.ts");

// 1. Diacritic folding must run after NFKC and BEFORE the charset filter.
assert.ok(
  parser.includes('.normalize("NFD").replace(/[\\u0300-\\u036f]/gu, "")'),
  "normalizeMatchText must NFD-fold combining marks before the charset filter"
);

// 2. The fold must sit after the katakana transliteration (both are
//    pre-charset-filter normalizations).
const katakanaAt = parser.indexOf(".replace(/ルイ/gu");
const foldAt = parser.indexOf('.normalize("NFD")');
const charsetAt = parser.indexOf(".replace(/[^a-zа-яіїєґ0-9\\s]/giu");
assert.ok(katakanaAt !== -1 && foldAt !== -1 && charsetAt !== -1, "all three normalization stages must exist");
assert.ok(katakanaAt < foldAt && foldAt < charsetAt, "normalization order must be: katakana transliteration, diacritic fold, charset filter");

// 3. Strict gate shape unchanged.
assert.ok(parser.includes("if (normalized.startsWith(`${address} `))"));
assert.ok(parser.includes("export function containsEmergencyStopWord"));

// 4. Chain hygiene (carried from v2.1.155/157/160/161).
assert.ok(pkg.scripts.test.includes("v2.1.162-diacritic-fold-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.162 diacritic fold regression: PASS");
