import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 152);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 152);

// Regression: on some Android devices (UBS1 / Android 14), unmounting a result
// <Text> that is currently on screen — synchronously, inside a tap handler —
// sends the native UI thread into an infinite relayout loop (RenderThread +
// main each pin ~45% CPU; app freezes; JS starves). Confirmed twice on the
// robot section (tap Find LOOI / candidate with result text visible) and once
// on the Updates section (tap "Check for updates" twice). Fix: result texts
// stay mounted forever; empty state swaps style to display:"none" and content
// to "" — a prop update, never an unmount.

const settings = read("app/(tabs)/settings.tsx");

// The conditional-unmount shape must be gone entirely.
assert.doesNotMatch(
  settings,
  /\{[A-Za-z.]+ \? <Text style=\{styles\.result\}>/,
  "conditional result Text mounts/unmounts are forbidden — use always-mounted + resultHidden"
);

// Hidden style must exist and keep the node mounted (no unmount alternative).
assert.match(settings, /resultHidden: \{ display: "none" \},/);

// All known result sites must use the hidden fallback pattern.
const sites = [
  "geminiKeyResult",
  "openAiKeyResult",
  "openAiModelsResult",
  "voicePreviewResult",
  "robotUi.result",
  "updateResult",
  "backupResult",
  "diagnosticResult",
  "testResult",
];
for (const site of sites) {
  const pattern = new RegExp(
    `<Text style=\\{${site.replace(".", "\\.")} \\? styles\\.result : styles\\.resultHidden\\}>\\{${site.replace(".", "\\.")} \\?\\? ""\\}</Text>`
  );
  assert.ok(pattern.test(settings), `result site "${site}" must render always-mounted with resultHidden fallback`);
}

// Tap handlers must not null the robot result (point fix from the same bug):
// the render fix makes this redundant, but keeping stale text during a retry
// is also the intended UX — scanning/busy states replace it with real results.
assert.doesNotMatch(settings, /scanning: true, result: null/);
assert.doesNotMatch(settings, /busy: true, result: null/);

console.log("v2.1.152 settings result-text freeze regression: PASS");
