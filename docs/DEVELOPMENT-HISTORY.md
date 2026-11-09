# Development history & handoff — my-looi fork (feat/gemini-live-provider)

Everything the fork has done since it diverged from upstream, written for
whoever picks this up next (human or agent). Companion documents:
[`voice-commands.md`](voice-commands.md) (the phrase-level interception
reference) and [`debugging.md`](debugging.md) (field pitfalls: BLE recovery
ladder, adb/landscape, build/test traps). This file is the story and the map.

- **Fork**: `github.com/madcatone/my-looi`, branch `feat/gemini-live-provider`
  (there is no remote named `github`; push with `git push origin …`).
- **Upstream**: `razor79/my-looi`; our branch sits on upstream release
  **v2.1.151** (`c9d94ce`). Commits `04fb246`/`b22f853`/`c274265`/`c9d94ce`
  below that are upstream releases, not ours.
- **Goal**: a switchable **Gemini Live** voice provider for the Realtime PCM
  path (the app originally spoke only the OpenAI Realtime protocol), plus
  reliable **voice-controlled robot movement**.
- **Status as of 2026-11-09**: v2.1.166 installed and verified on device —
  forward/back/turn/180°/stop/nod/dance/sleep by voice, cloud replies
  suppressed for locally-executed commands, chat still works normally.

## Where things live

| Concern | File |
|---|---|
| Wake-name aliases, address/command parsing | `src/voice/explicit-robot-command.ts` |
| Interception routing + emergency STOP + local acks | `src/voice/realtime-physical-command.ts` |
| Realtime session, model-output suppression | `src/voice/realtime-pcm-conversation.ts` |
| OpenAI↔Gemini event translation (pure, Node-testable) | `src/gemini/gemini-live-protocol.ts` |
| Robot motion primitives, safety interlocks, FED9 handling | `src/device-tools/looi-robot.ts` |
| FED9 frame decoder (cliff 5-byte, TOF `0e`, dock) | `src/device-tools/fed9-sensors.ts` |
| BLE transport (GATT map, handshake characteristics) | `src/device-tools/react-native-ble-transport.ts`, `looi-robot-autoconnect.ts` |
| Diagnostics ring buffer + (since v2.1.166) logcat mirror | `src/diagnostics/diagnostic-log.ts` |
| Vendor SDK (drive frames 7707/86fc/047a/0082/0000, 110ms keepalive) | `node_modules/@sourcebug/looi-sdk/src/index.ts` |
| Regression tests (one per version, pinned source fragments) | `scripts/v2.1.*.test.mjs` |

## Timeline

### 2026-11-04 — Gemini Live provider (the foundation)

- `422edd4` **feat(gemini): switchable Gemini Live provider** on the Realtime
  PCM voice path. Pure translation layer (`gemini-live-protocol.ts`) between
  the app's OpenAI Realtime event dialect and the Live API
  BidiGenerateContent wire format — kept free of React Native imports so
  `scripts/*.test.mjs` can exercise it under Node.
- `04b343f` onboarding accepts an OpenAI **or** Gemini key.
- `d7b76a5` decode **binary** WebSocket frames (the Live API returns binary;
  treating every frame as text turned payloads into `[object Blob]` and
  dropped them silently) + surface close-before-ready failures.
- `a30a408` BLE scan observability + provider-aware status card.

### 2026-11-05 — native UI freeze

- `5ad876d`/`8764d29` tapping robot buttons **froze the whole app** when
  result text was shown: removing a `<Text>` node from the tree sent that
  device's RN native layout into an infinite relayout (RenderThread+main
  ~45% CPU each, JS thread idle). Class fix: keep result texts always-mounted
  and update content in place instead of conditionally unmounting.

### 2026-11-05 (afternoon onward) — voice interception & the wake-name roulette

- `9ae43e0` more 180° phrasings + English wake-name transcriptions.
- `aa28dcb` **instrumented logging** (`[RealtimeCmd] transcript=… physical=…`)
  — every diagnosis since has run on this.
- `d413500` **v2.1.154**: addressless verb-led commands inside a realtime
  session (later reverted — see 159).
- `77d0b70` **v2.1.155**: Look/Lewis/Lou/Luke aliases + repaired the npm test
  chain tail (a sed append had embedded `\"` in the JSON value, so tail
  commands were filenames with a trailing quote — since then every package.json
  chain edit goes through a node JSON round-trip, never sed).
- `1f125fd` **v2.1.156**: English politeness lead-ins (please/okay/ok) after
  the address — found by a fresh-context doc read-back, not by testing.
- Same day: `docs/voice-commands.md` + `docs/debugging.md` written.

### 2026-11-09 — the big day: gate policy, split-brain, TOF

- `34eb61f` **v2.1.157** Blue Eye. `628d762` **v2.1.158** one-word tolerance
  (reverted the same hour — see 159).
- `c9f18af` **v2.1.159 — the product decision**: **strict keyword gate**. User
  decision: wheel commands fire ONLY when the utterance starts with an
  accepted robot address; everything else goes to the cloud model. 154's
  addressless parser and 158's tolerance were both reverted by design.
- `fc2e645`/`4e51e92`/`379f17b`/`b310420` **v2.1.160–163**: the roulette
  continues — Rui; Luis/Lui/robar + katakana ルイ→rui + possessive `'s` strip;
  NFD diacritic fold (Luís→luis) + ruin/robots; lo es/blue is/Louise.
- `8668fa1` **v2.1.164 — split-brain turn fix**: the robot executed a command
  locally but the cloud still answered "I can't turn left". Two causes: (1)
  the Gemini adapter translated `response.cancel` into
  `clientContent {turns:[],turnComplete:true}` — but **clientContent IS user
  input** in the Live API, so every "cancel" actively prompted the model to
  respond; cancellation is now entirely client-side (emits nothing). (2)
  suppression was only the ~700ms execution window; now a turn-scoped flag
  (`suppressModelOutputUntilNextUserTranscript`) drops all model output until
  the next user transcript.
- `58a5401` **v2.1.165**: Blue East + **verb-tense inflections** —
  "Lewis turned left" missed because MOVE_VERB_RE only had base forms.
- `bf37a19` **v2.1.166 — forward never moved**: root cause below. Fail-open
  for silent TOF + `recordDiagnosticEvent` mirrored to logcat as `[Diag] …`.

## The three load-bearing decisions

1. **Strict address gate (v2.1.159, user decision).** Wheel commands require
   an accepted address at utterance start; addressless verb-led and bare
   direction words go to the cloud BY DESIGN. Emergency "stop" is the only
   global exception. Wake-name misses are handled by enumerating observed
   transcription aliases (20+ variants so far, `BUILTIN_ADDRESS_ALIASES`) plus
   normalization classes (katakana transliteration, NFD diacritic fold,
   possessive strip) — NOT by loosening the gate.
2. **Cancellation is client-side (v2.1.164).** The Live API has no
   server-side cancel, and `clientContent` with `turnComplete:true` means
   "the user finished speaking — please respond". Never translate
   `response.cancel` into it.
3. **Silent TOF must not paralyze forward (v2.1.166, user decision).** This
   robot unit never streams TOF (`0e`) frames; requiring a decoded reading
   for forward made it permanently immovable forward while back/turn (which
   never consult TOF) moved fine. Fail-open ONLY for missing data: a decoded
   obstacle still hard-blocks, cliff/near-edge interlocks and the 700ms bound
   are unchanged, the mid-motion TOF stop stays armed.

## The forward bug — diagnosis that generalizes

Symptom: back/turn worked, forward never moved, reply "I couldn't do that".
That string is the **local blocked ack**, not a cloud refusal —
indistinguishable by ear. The chain: no `0e` TOF frames ever →
`computeSafety` returns `tof-unknown` → 700ms warmup timeout →
`movement-blocked` throw → failure ack. Diagnosis depended on three things:
the `[RealtimeCmd]` verdict log (does the parser see it?), the `[Diag]` logcat
mirror (what did the execution layer decide, with reason strings), and
cross-era log comparison (the same unit never streamed TOF on any day —
forward had likely never worked by voice on it). Full write-up in
[`debugging.md`](debugging.md) § "2026-11-09 postscript".

## Version map (our commits)

| Version | Commit | One-liner |
|---|---|---|
| — | `422edd4`–`a30a408` | Gemini Live provider + onboarding + binary frames + BLE observability |
| — | `5ad876d`,`8764d29` | Native UI freeze fix (always-mounted result texts) |
| — | `9ae43e0`,`aa28dcb` | 180° phrasings; interception verdict logging |
| 154 | `d413500` | addressless session parser (later reverted) |
| 155 | `77d0b70` | Look/Lewis/Lou/Luke; test-chain tail repair |
| 156 | `1f125fd` | politeness lead-ins |
| 157 | `34eb61f` | Blue Eye |
| 158 | `628d762` | one-word tolerance (reverted) |
| 159 | `c9f18af` | **strict keyword gate** (design reversal) |
| 160 | `fc2e645` | Rui |
| 161 | `4e51e92` | Luis/Lui/robar, ルイ, possessive `'s` |
| 162 | `379f17b` | NFD diacritic fold, ruin/robots |
| 163 | `b310420` | lo es / blue is / Louise |
| 164 | `8668fa1` | **split-brain cancel fix + turn-scoped suppression** |
| 165 | `58a5401` | Blue East + verb-tense inflections |
| 166 | `bf37a19` | **TOF fail-open + `[Diag]` logcat mirror** |

Version ritual (since 154, apply to every change): bump `package.json` (via
node JSON round-trip, never sed) + append the new test to the `"test"` chain;
`app.json` `expo.version` + `android.versionCode`; `android/app/build.gradle`
versionCode/versionName (gitignored, exists only in a built tree); new
`scripts/v2.1.NNN-<topic>.test.mjs`; update version/hash pins in older tests
that the deliberate change invalidates (151 pins exact versions; 144/151 pin
the SHA-256 of `realtime-pcm-conversation.ts`; 153 pins parser literals).

## Build / install / test

```bash
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  NODE_OPTIONS=--use-system-ca ./gradlew :app:assembleRelease
ADB=~/Library/Android/sdk/platform-tools/adb   # not on PATH
$ADB shell input keyevent KEYCODE_WAKEUP        # screen must be awake or the OS kills the app
$ADB shell am force-stop io.github.razor79.mylooi
$ADB install -r android/app/build/outputs/apk/release/app-release.apk
$ADB shell monkey -p io.github.razor79.mylooi -c android.intent.category.LAUNCHER 1
```

Our app's package is **`io.github.razor79.mylooi`** (the vendor app
`com.TangibleFuture.looiRobot` is also installed — don't confuse them).
Device: UBS1, serial UBS1241115010673, Android 14, **locked landscape
1600×720** (screenshot size, not `wm size`).

Tests: `node scripts/v2.1.<NNN>-….test.mjs` individually. The full `npm test`
chain is **broken at v2.1.137** — upstream v2.1.151 gutted the native
`captureStill` while `src/vision/look-here.ts:44` still calls it (visual
look-here is broken upstream; pre-existing, not ours).

After every install expect the **BLE recovery ladder**: the robot holds a
dead link; 1–3 app restarts, then robot power cycle. Check the log before
restarting — a running app auto-reconnects when the robot comes back. After
using the vendor app, our connect can hang with no callback; one restart
usually recovers.

## Open threads

1. **Wake the TOF stream (user-approved follow-up).** The unit never sends
   `0e` frames; the legacy handshake (FEDA/FEF0 three-step, sent on every
   connect, answered `59`='Y') doesn't start sensor telemetry. Next probe:
   enable Bluetooth **HCI snoop logging**, drive the robot from the vendor
   app (its forward works), diff its writes against ours to find the enable
   command. v2.1.166's fail-open makes this a quality improvement, not a
   blocker.
2. **Upstream bug reports** (not yet filed): the v2.1.137 chain break above;
   anything else worth a PR (freeze fix, voice fixes, cancel semantics) —
   user undecided about upstreaming.
3. **Deferred features**: Ark / Volcengine 豆包 realtime adapter (needs user
   credentials); wiring more device APIs to voice (`setLooiHead`
   up/center/down, `setLooiLight`, duration words, dance styles — inventory
   in `looi-robot.ts` around :660–:1030); French grammar gap ("lui va").
4. ~~Docs drift~~ closed 2026-11-09: `voice-commands.md` now covers the
   aliases through v2.1.165, verb inflections, and the word-search semantics
   of the addressed parser (plus the observed-but-unshipped `Luiz`/`Loius`
   note).
