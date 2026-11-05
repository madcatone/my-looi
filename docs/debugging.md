# Field debugging notes

Practical debugging playbook for this app on a real robot + Android device,
distilled from the v2.1.152–154 work (native freeze, BLE reconnects, voice
interception). Each entry: symptom → diagnosis → fix → lesson.

## 1. Instrument the decision point before shipping a guess

**Symptom**: "Voice recognition is poor, the robot often says it can only
chat; 180° turns never worked." A phrase-widening fix (v2.1.153) shipped
without any way to observe what the provider actually transcribed, and did
not solve the user's case.

**Diagnosis**: added one console line at the interception point
(`realtime-pcm-conversation.ts`, `[RealtimeCmd] transcript=… physical=…`).
One round of on-device testing then showed both root causes verbatim:
`"Louis, turn around."` (unknown alias) and `"Turn one hundred eighty
degrees."` (address never spoken — user drops it mid-session).

**Fix**: alias family + in-session parser (v2.1.154), verified by log.

**Lesson**: when a fix depends on what an external system (STT, server,
sensor) actually said, add observability at the boundary *first* and let one
round of real data pick the fix. The v2.1.153 widening was aimed at imagined
transcripts.

## 2. Native UI freeze: never unmount an on-screen `<Text>` in a tap handler

**Symptom**: on a UBS1 / Android 14 device, tapping certain settings buttons
freezes the whole app — no JS errors, logcat goes quiet, screenshot frozen.

**Diagnosis**: `top -H -b -n 1 -p <pid>` showed RenderThread and main each
pinning ~45% CPU while the JS thread sat idle — a native UI-thread spin, not
a JS hang. On-device A/B (same button with and without the result text
visible) isolated the trigger: the tap handler synchronously set state that
conditionally **unmounted** a visible `<Text>`, sending native layout into an
infinite relayout loop on this device.

**Fix**: result texts stay mounted forever; the empty state swaps style to
`display: "none"` and content to `""` (`app/(tabs)/settings.tsx`). Guarded by
`scripts/v2.1.152-settings-result-text-freeze-regression.test.mjs`, which
forbids the conditional-unmount shape entirely.

**Lesson**: "JS is quiet" ≠ "JS is hung" — attribute per-thread CPU first.
On affected devices, prefer in-place content updates over conditional
unmounts of rendered text nodes.

## 3. Voice interception misses: two address-gate failures

**Symptom**: every movement command in a Gemini Live session fell through to
the LLM ("I can only chat"); 180° never worked even after phrase widening.

**Diagnosis** (from the `[RealtimeCmd]` log): (a) Gemini transcribes the wake
name nondeterministically across the /lu/-initial family — the same spoken
"LOOI, forward" came back as *Louis* (intercepted), *Look* and *Lewis*
(missed) on consecutive attempts; Gemini has no equivalent of OpenAI's STT
biasing that would pull transcription back to "LOOI"; (b) the user naturally
drops the address mid-session, and every addressless utterance was rejected
by design. User reports like "back works but forward doesn't" were roulette
on the name transcription, not a direction-specific bug.

**Fix** (v2.1.154–155): widened the alias family to the observed variants
(louis, look, lewis) plus their phonetic siblings (lou, luke); added
`parseSessionRobotCommand` as a fallback **only inside the live realtime
session** — it accepts whole-utterance verb-led imperatives (`turn 180
degrees`, `go ahead`) so conversation text and bare directions/numbers can
never match. Verified with behavioral matrices plus on-device logs (all
utterances intercepted and executed once the aliases landed).

**Lesson**: a mandatory-address gate is a fine default, but once the user has
performed an explicit wake gesture, that gesture *is* the address. Widen the
gate at the session boundary, not by loosening the grammar.

## 4. BLE reconnect behaviors and the recovery ladder

Observed robot/BLE facts:

- The robot **stops advertising** when asleep/idle or while the official app
  holds its connection. Official app must be closed and the robot
  power-cycled before this app can scan it.
- `adb install -r` requires `am force-stop` first, and force-stop kills the
  app **without a clean BLE disconnect** — the robot keeps the dead link and
  refuses new ones. Auto-connect then fails repeatedly with
  `[BleError: Operation was cancelled]`.
- Recovery ladder: restart the app (fixes it within 1–2 tries once the robot
  notices the dropped link) → power-cycle the robot (always works). A running
  app reconnects on its own when the robot power-cycles (the disconnect
  handler retries), so **check the log before restarting the app** — an eager
  restart can kill a connection that just recovered.

**Lesson**: after every install, expect one reconnect dance; verify
`[LOOI BLE] Robot connected and handshake complete` in the log before
declaring the robot "broken".

## 5. adb on a locked-landscape device

- **Tap coordinates**: `wm size` reports portrait (720×1600) while the app
  locks landscape — `screencap` frames are 1600×720. Always derive tap
  coordinates from the actual screenshot dimensions (`sips -g pixelWidth -g
  pixelHeight`), never from `wm size`.
- **Finding buttons**: `uiautomator dump` fails with "could not get idle
  state" on continuously-animating apps (the face animates constantly).
  Locate buttons by pixel analysis instead — scan the screenshot for the
  bright theme color (PIL color-blob detection) or bright-text rows; visual
  estimation of coordinates is unreliable.
- **Logcat**: the system log churns the circular buffer in under a minute.
  Keep a persistent capture running:
  `nohup adb logcat -v time > /tmp/looi-logcat-liveN.log 2>&1 &`
  and grep that file, rather than `adb logcat -d`.
- Release builds give you no `run-as`, no debuggerd dumps; console.log via
  ReactNativeJS in logcat is the debug channel.

## 6. Build and test infrastructure

- `expo prebuild --clean` **wipes `android/local.properties`** — rewrite
  `sdk.dir=$HOME/Library/Android/sdk` before `./gradlew assembleRelease`, or
  the build dies with "SDK location not found".
- Skipping prebuild (just `gradlew :app:assembleRelease`) builds the JS from
  current source — code changes are live — but leaves a **stale
  versionCode/versionName** in the APK (they live in
  `android/app/build.gradle` and are only regenerated by prebuild). Check
  `adb shell dumpsys package … | grep version` after installing; a stale
  version does not block `adb install -r` replacement.
- The `npm test` chain is currently **broken at
  `v2.1.137-explicit-visual-look-regression`**: upstream v2.1.151 removed the
  native `captureStill` JPEG path from
  `modules/local-face-attention/…/LocalFaceAttentionModule.kt` while
  `src/vision/look-here.ts:44` still calls it — the visual look-here feature
  is broken upstream and the test correctly catches it. Run voice-related
  tests individually (111, 126, 127, 143, 144, 151, gemini, 152, 153, 154)
  until that is resolved.
- Deliberate source changes require updating **pin assertions in older
  tests**: v2.1.151 pins the exact version strings, and v2.1.153 pins the
  glued-splitter alias list literally. This is by design — the pins are the
  regression net; update them in the same commit as the deliberate change.
- Loop runners beware: test files are named `<topic>.test.mjs`. A loop that
  forgets the `.test` segment reports every test as "module not found" —
  which looks exactly like a mass test failure.
- Appending to the npm test chain with sed once left an escaped quote inside
  the JSON string value (`…test.mjs\" && node …`), so the shell command ended
  with `mjs"` — a filename with a trailing quote, module not found. Nobody
  noticed because the chain dies at v2.1.137 long before the tail runs.
  v2.1.155's test now asserts the chain contains no stray quotes inside
  commands; prefer a structured edit (jq / node script) over sed for this
  line.
