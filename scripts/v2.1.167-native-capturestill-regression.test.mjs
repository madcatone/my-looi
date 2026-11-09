import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 167);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 167);

// Regression: the upstream v2.1.151 squash (c9d94ce) carried the JS side of the
// explicit visual look feature (index.ts types, look-here.ts, realtime
// interception, the v2.1.137/138 regression tests) but never brought over the
// Kotlin captureStill implementation — calling it at runtime threw and the
// chain has been broken at v2.1.137 since. v2.1.167 implements the native
// side to the spec the two upstream tests already pin.

const kotlinPath = "modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt";
const kotlin = read(kotlinPath);
const indexTs = read("modules/local-face-attention/index.ts");

// 1. The module exposes captureStill to JS with a cameraFacing argument.
assert.match(kotlin, /AsyncFunction\("captureStill"\) Coroutine \{ cameraFacing: String ->/);

// 2. In-memory JPEG still pipeline: TEMPLATE_STILL_CAPTURE, JPEG quality, Base64
//    NO_WRAP, and no disk writes.
assert.match(kotlin, /ImageFormat\.JPEG/);
assert.match(kotlin, /CameraDevice\.TEMPLATE_STILL_CAPTURE/);
assert.match(kotlin, /CaptureRequest\.JPEG_QUALITY/);
assert.match(kotlin, /Base64\.encodeToString\(bytes, Base64\.NO_WRAP\)/);
assert.doesNotMatch(kotlin, /FileOutputStream|openFileOutput|MediaStore/);

// 3. Camera lifecycle: explicit switch helper, and restore to the pre-capture
//    camera afterwards (face analysis paused while on the back camera).
assert.match(kotlin, /switchCameraForExplicitCapture\(manager: CameraManager, requestedFacing: String\)/);
assert.match(kotlin, /pendingCaptureRestoreFacing/);
assert.match(kotlin, /restoreAnalysisAfterStill/);
assert.match(kotlin, /detector = if \(lensFacingName == "front"\) createDetector\(\) else null/);

// 4. Field contract: every spot-checked key the JS LocalStillCapture type
//    declares is returned by the Kotlin result map with a matching value shape.
for (const [tsPattern, kotlinPattern] of [
  [/mimeType: "image\/jpeg";/, /"mimeType" to "image\/jpeg"/],
  [/base64: string;/, /"base64" to base64/],
  [/width: number;/, /"width" to width/],
  [/height: number;/, /"height" to height/],
  [/lowLightLikely: boolean;/, /"lowLightLikely" to isLowLightLikely/],
]) {
  assert.match(indexTs, tsPattern, `index.ts LocalStillCapture must declare ${tsPattern}`);
  assert.match(kotlin, kotlinPattern, `Kotlin captureStill result must contain ${kotlinPattern}`);
}
// lowLightLikely must be a Boolean on both sides of the bridge.
assert.match(kotlin, /private fun isLowLightLikely\(exposureTimeNs: Long\?, sensitivityIso: Int\?\): Boolean/);

// 5. Version ritual: 2.1.167 / 167 in all three places.
const gradle = read("android/app/build.gradle");
assert.match(pkg.version, /^2\.1\.168$/);
assert.match(app.expo.version, /^2\.1\.168$/);
assert.equal(app.expo.android.versionCode, 168);
assert.match(gradle, /versionCode 168\b/);
assert.match(gradle, /versionName "2\.1\.168"/);

// 6. Chain hygiene: this test is in the npm test chain, with no stray quotes.
assert.ok(pkg.scripts.test.includes("node scripts/v2.1.167-native-capturestill-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.167 native captureStill implementation + version ritual: PASS");
