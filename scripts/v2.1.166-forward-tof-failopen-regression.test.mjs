import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 166);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 166);

// Regression: "Louis, go straight" was intercepted, executed… and never moved
// — every forward was blocked by the tof-unknown interlock. This robot unit
// never streams TOF frames (zero 0e FED9 captures since the 2026-08
// calibration), so requiring a decoded TOF reading before ANY forward motion
// meant forward was permanently unusable, while back/turn (which never consult
// TOF) kept moving with the same absent sensor data. The vendor app drives the
// same robot forward without our gate, confirming the wheels and firmware are
// fine.
//
// v2.1.166 (user decision "两个都做"): fail open for the missing-data case
// only. A decoded obstacle still hard-blocks; cliff/near-edge interlocks and
// the global emergency STOP are unchanged; the mid-motion TOF safety stop
// stays armed in case the stream ever wakes up.

const robot = read("src/device-tools/looi-robot.ts");

// 1. The tof-unknown block is gone: silence must not read as "unsafe".
assert.ok(
  !robot.includes('reason = "tof-unknown"'),
  "tof-unknown must no longer block forward — missing data is not an obstacle"
);

// 2. A decoded obstacle still hard-blocks forward.
assert.match(
  robot,
  /direction === "forward" && state\.sensors\.obstacleNear\) \{\s*\n\s*safetyState = "unsafe";\s*\n\s*reason = "obstacle";/,
  "a decoded TOF obstacle must still block forward"
);

// 3. The mid-motion TOF safety stop stays armed.
assert.match(
  robot,
  /decoded\.obstacleNear && state\.activeDirection === "forward"/,
  "mid-motion TOF safety stop must remain active for forward"
);

// 4. Cliff and near-edge interlocks untouched.
assert.match(robot, /reason = "near-edge-front"/);
assert.match(robot, /reason = `cliff-\$\{cliffDirectionLabel\(direction\)\}`/);

// 5. Diagnostics mirror to logcat (shipped in the same version): the
// execution-layer verdicts must be visible in adb logcat, not only in the
// exportable archive — this diagnosis round depended on it.
const diagLog = read("src/diagnostics/diagnostic-log.ts");
assert.match(
  diagLog,
  /console\.log\(`\[Diag\] \$\{category\} \$\{event\}\$/,
  "recordDiagnosticEvent must mirror events to logcat"
);

// 6. Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.166-forward-tof-failopen-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.166 forward TOF fail-open + diagnostics mirror: PASS");
