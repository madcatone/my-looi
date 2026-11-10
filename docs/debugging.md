# Field debugging notes

Practical debugging playbook for this app on a real robot + Android device,
distilled from the v2.1.152–156 work (native freeze, BLE reconnects, voice
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
transcripts. The same discipline applies to docs: a fresh-context read-back
of `voice-commands.md` caught the doc claiming English politeness lead-ins
were stripped when the code only stripped Russian ones (`LOOI, please
forward` really did fall to the LLM) — fixed in v2.1.156.

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
gate at the session boundary, not by loosening the grammar. And when the
failure mode is "an external system mangles the same token differently every
time", stop enumerating the manglings: after nine wake-name variants
(louie/louis/look/lewis/lou/luke/blue eye/zoe/dui), v2.1.158 switched to
tolerating one unrecognized leading word in front of an exact session
imperative — the anchored grammar is the safety net, so unknown future
variants are handled without another release.

**Postscript (v2.1.159, same day)**: the user then chose to revert both the
addressless imperatives (v2.1.154) and the tolerant strip (v2.1.158) in favor
of a strict keyword gate — predictability over recall — keeping the alias
family (now including zoe/dui) as the keyword. Both approaches were
technically sound; the choice between them is a product decision, not a
technical one. When tolerance vs. strictness is genuinely arguable, ask
before shipping either.

## 4. BLE reconnect behaviors and the recovery ladder

Observed robot/BLE facts:

- The robot **stops advertising** when asleep/idle or while the official app
  holds its connection. Official app must be closed and the robot
  power-cycled before this app can scan it.
- `adb install -r` requires `am force-stop` first, and force-stop kills the
  app **without a clean BLE disconnect** — the robot keeps the dead link and
  refuses new ones. Auto-connect then fails repeatedly with
  `[BleError: Operation was cancelled]`.
- Recovery ladder: restart the app (`adb shell am force-stop
  io.github.razor79.mylooi` then relaunch, or tap the icon) — fixes it within
  1–2 tries once the robot notices the dropped link → power-cycle the robot
  (always works). A running app reconnects on its own when the robot
  power-cycles (the disconnect handler retries), so **check the log before
  restarting the app** — an eager restart can kill a connection that just
  recovered.

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
- The `npm test` chain advanced past v2.1.137/138 in v2.1.167 and now stops
  at `v2.1.139-android-photo-picker-visual-context-regression`: the upstream
  v2.1.151 squash shipped the JS side of visual look-here
  (`src/vision/look-here.ts:44` calls `captureStill`) without the Kotlin
  `captureStill` implementation — the native half never existed in our tree,
  so the call threw at runtime; v2.1.167 implements the native side. The
  remaining 139/140 failures are the same squash gap for the photo-picker
  native module (`modules/photo-picker-access/…/PhotoPickerAccessModule.kt`
  missing) — run tests individually as needed until that is filled.
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
  noticed because the chain then died at v2.1.137 long before the tail runs
  (several tests, e.g. v2.1.155/166/167, now assert the chain has no stray
  quotes, so the check no longer depends on the tail executing).
  v2.1.155's test now asserts the chain contains no stray quotes inside
  commands; prefer a structured edit (jq / node script) over sed for this
  line.

## 2026-11-09 postscript: "forward never moves" — TOF silence vs sensor block

Symptom: back/turn worked by voice, forward never moved, and the reply was
"I couldn't do that". Diagnosis trail worth remembering:

- **"I couldn't do that" is the LOCAL blocked ack**
  (`realtime-physical-command.ts` `acknowledgementFor(…, false)`), not a cloud
  refusal. It is indistinguishable by ear. When you hear it after a
  `physical=explicit` verdict, the execution layer threw — check `[Diag]`
  lines, not the model.
- **`[Diag]` lines are in logcat since v2.1.166**
  (`recordDiagnosticEvent` mirrors to console). Every execution-layer verdict
  — `movement-blocked`, `sensor-warmup-timeout`, `sensor-safety-stop`,
  `tof-state`, `move-start/stop`, `realtime-physical-command-finished ok=…` —
  is now greppable live: `adb logcat | grep '\[Diag\] robot'`. Before v2.1.166
  these lived only in the exportable archive (Settings → Diagnostics). Expect
  ~2 Hz `pcm-uplink-level` noise; filter it out.
- **Root cause of the forward block**: this robot unit never streams TOF —
  zero `0e` FED9 frames across every capture since the 2026-08 calibration
  (the sparse 3-byte `110100` / `02xxxx` frames are unknown-type, not TOF).
  `computeSafety` required a decoded TOF reading for ANY forward motion, so
  `tof-unknown` blocked forward permanently while back/turn (which never
  consult TOF) kept moving. Forward had likely never worked by voice on this
  unit; the vendor app drives it fine. v2.1.166 fails open for the
  missing-data case only: a decoded obstacle still hard-blocks, cliff and
  near-edge interlocks and the 700ms bound are unchanged.
- **GATT write counts are not drive evidence**: `onWriteCharacteristic` lines
  in logcat carry no characteristic or payload, and they include handshake
  (FEDA/FEF0), head-gesture (FED1) and ambient-pivot writes. An early
  forensic pass read "6 writes after a forward command" as a drive sequence;
  it was the failure head-gesture plus handshake writes. Filter by nothing
  available at the OS layer — if you need payloads, enable **Bluetooth HCI
  snoop logging** in developer options and pull the bugreport.
- **BLE after vendor-app use**: after driving the robot from the original
  LOOI app, our app's connect can hang with no callback (dead link held on
  the robot side). One app restart recovered it this time; the usual ladder
  (1–3 restarts, then robot power cycle) applies.

## 2026-11-10 postscript: the silent Gemini session (not BLE, not quota)

Symptom: app listening, mic fine (pcm-uplink rms shows normal speech
bursts), WebSocket open — but zero `pcm-speech-started`/transcripts; the
user talks to a brick. After ~2.5 min the server closes the socket
`code=1000 reason=` (empty; contrast the session-duration GoAway, which is
`code=1008` with an explicit reason). A fresh app relaunch opens a new
session that works immediately — so it is a transient dead server-side
session, not the API key's quota and not our code. Diagnosis trick: the
`pcm-uplink-level` rms stream proves the mic path; if rms shows speech
bursts while not one `speech-started` fires, the fault is upstream of VAD.
Recovery: same ladder shape as BLE — restart the app, expect a fresh
working session; don't debug your latest diff first (the 2026-11-10 round
initially looked like a v2.1.169 regression; the startup log was
line-identical to the working session minutes earlier).
