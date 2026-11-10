# LOOI Robot Device API — byte-level reference

This document describes the LOOI robot's BLE control interface at byte level, so an
external developer can write their own app to drive the robot **without this
repository**. Everything here is extracted from the code in this repo (citations
inline) or from on-device observation (marked **[empirical]**). Where code carries
only a magic number with no stated semantics, we say so explicitly rather than
guessing.

Citation key (all paths relative to repo root):

- `sdk` = `node_modules/@sourcebug/looi-sdk/src/index.ts` (byte-identical local mirror: `packages/looi-sdk/src/index.ts`)
- `transport` = `src/device-tools/react-native-ble-transport.ts`
- `robot` = `src/device-tools/looi-robot.ts`
- `fed9` = `src/device-tools/fed9-sensors.ts`
- `autoconnect` = `src/device-tools/looi-robot-autoconnect.ts`
- `sleep` = `src/core/sleep-mode.ts`
- `bootstrap` = `src/core/app-bootstrap.ts`

---

## 1. BLE connection layer

### Service

| Item | Value | Source |
|---|---|---|
| GATT service UUID | `000000ff-0000-1000-8000-00805f9b34fb` (short form `0x00FF`) | `transport:22`, `sdk:3` |

### Characteristics (all under the service above)

| Key | UUID (short) | Direction / use | Write mode used by code | Source |
|---|---|---|---|---|
| drive | `0xFED0` | client → robot, wheel motion frames | without response preferred | `transport:29`, `sdk:290` |
| head | `0xFED1` | client → robot, head position | without response | `transport:30`, `sdk:332` |
| light | `0xFED2` | client → robot, light on/off | **with** response | `transport:31`, `sdk:337-340` |
| dockNotify | `0xFED9` | robot → client, notify (sensor/dock frames, §5) | n/a | `transport:32`, `sdk:237-249` |
| handshakeControl | `0xFEDA` | client → robot, handshake steps 1 and 3 (§2) | **with** response | `transport:33`, `sdk:50-52` |
| handshakeData | `0xFEF0` | client → robot (time payload, §2) **and** robot → client notify (replies) | **with** response | `transport:34`, `sdk:51`, `sdk:263-269` |
| rawFe00 | `0xFE00` | enumerated in both UUID tables; runtime code never reads or writes it, but the SDK README ships one unexplained raw-write example (`writeRaw("fe00", "00100000010032030a0001ff00010a3203ff0003", { response: true })`, `packages/looi-sdk/README.md:57`) — purpose unknown, kept here as the only known clue | — | `transport:35`, `sdk:12` |

Write-mode fallback: the transport prefers write-without-response when the SDK asks
for it, then falls back to write-with-response, then write-without-response,
according to the properties the peripheral actually exposes (`transport:251-292`).
A characteristic that supports neither read-relevant write mode is rejected
(`transport:291`).

### Advertising and discovery

- Advertised name: `LOOI Robot` (`transport:23`). Override via env
  `EXPO_PUBLIC_LOOI_ROBOT_NAME` (`transport:106`).
- Match rule used by this repo: exact name match, **or** name containing `looi`
  (case-insensitive), **or** advertising the service UUID `000000ff-…`
  (`transport:594-599`).
- Android scan uses `ScanMode.LowLatency` (`transport:421-422`).
- Default timeouts: scan 12 000 ms (`transport:24`), BLE adapter ready 8 000 ms
  (`transport:25`), connect 10 000 ms (`transport:26`).
- Android runtime permissions: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`,
  `ACCESS_FINE_LOCATION` (Android 12+); older Android only fine location
  (`transport:530-547`).
- Android requests MTU 185 after GATT discovery (`transport:180-184`). iOS makes no
  MTU request in code. Connection interval / slave latency are not set anywhere in
  code (unknown).
- **[empirical]** A sleeping robot, or one held by the official LOOI app, stops
  advertising entirely — a scan finds nothing until it wakes / is released.

---

## 2. Handshake sequence

Performed once per connection, right after GATT discovery. The SDK subscribes
notifications first, then issues three writes (`sdk:228-282`):

| Step | Characteristic | Payload (hex) | Bytes | Write mode | Source |
|---|---|---|---|---|---|
| 0a | `0xFED9` | — subscribe notify | — | — | `sdk:237-249` |
| 0b | `0xFEF0` | — subscribe notify | — | — | `sdk:263-269` |
| 1 | `0xFEDA` | `03` | 1 | with response | `sdk:50` |
| 2 | `0xFEF0` | init time (see below) | 20 | with response | `sdk:51`, `sdk:271-279` |
| 3 | `0xFEDA` | `8101` | 2 | with response | `sdk:52` |

### The 20-byte time payload

ASCII string `A{YYYY} {MM} {DD} {HH} {mm} {ss}` — letter `A`, four-digit year,
then month/day/hour/minute/second as zero-padded two-digit decimal, separated by
single spaces; exactly 20 bytes (`sdk:146-150`). Example: `A2026 06 24 00 55 42`.
The SDK ships that exact example as its built-in default constant
(`sdk:1`), and generates the current time per connection otherwise (`sdk:272-274`).

### Responses and timeouts

- The SDK **never reads or validates any handshake response payload**. Completion is
  simply "all three writes were acknowledged" (`sdk:271-281`). There is no per-step
  timeout in SDK code — the writes are awaited directly.
- **[empirical]** During handshake the robot notifies `0x59` (`'Y'`) on `0xFEF0`.
  This is the device's success marker as observed on a real unit; the codebase does
  not check it, so treat it as a diagnostic, not a requirement.
- Firmware variant note: some production units expose `FED0/FED1/FED2/FED9/FE00`
  but **not** the `FEDA`/`FEF0` pair. On such units the handshake is skipped
  entirely and GATT discovery alone is treated as connected
  (`sdk:252-261`). The transport's `legacyHandshakeAvailable` flag is `true`
  only when the `FEDA`/`FEF0` pair IS present (`transport:332-334` ANDs two
  `has()` checks) — i.e. it means "handshake-capable", not "legacy".
- Every explicit `connect()` resets the completed flag and replays the handshake —
  stale handshake state is never trusted (`sdk:210-217`).

---

## 3. Motion control

### Drive frames (write to `0xFED0`, 2 bytes each, write-without-response)

| Direction | Bytes | Source |
|---|---|---|
| forward | `77 07` | `sdk:26` |
| back | `86 fc` | `sdk:28` |
| left (counter-clockwise turn) | `04 7a` | `sdk:27` |
| right (clockwise turn) | `00 82` | `sdk:29` |
| stop | `00 00` | `sdk:30`, `sdk:321-323` |

These are **opaque magic constants**. Neither byte's individual meaning (speed,
sign, wheel, checksum…) is stated anywhere in code. There is **no speed and no
duration field** in the frame — speed is fixed by firmware, and duration is pure
host-side timing. (The repo's own `moveLooi(direction, durationMs, _speed)` accepts
a speed argument that is silently ignored — `robot:679`.)

### Keepalive

Movement is driven by **repeating the same 2-byte frame every 110 ms** for as long
as the motion should last (`sdk:198`, `sdk:294-305`). The first frame is sent
immediately, then a timer re-sends it. How long a single frame keeps the wheels
moving without a repeat (device-side expiry) is not established anywhere in code.

### Host-side timing envelope (this repo's application layer)

| Quantity | Value | Source |
|---|---|---|
| Default bounded move | 700 ms | `robot:15` |
| Bounded move clamp | 80 – 1800 ms | `robot:16`, `robot:1351-1354` |
| Calibrated 90° turn | **650 ms** | `robot:29` |
| Calibrated 180° turn | **1560 ms** | `robot:30` |
| Continuous-motion deadman (auto-stop) | 5 000 ms | `robot:26`, `robot:1234-1254` |
| App-side BLE deadline: first drive write | 1 800 ms | `robot:18` |
| App-side BLE deadline: stop write | 900 ms | `robot:19` |

Turns are always duration-bounded; continuous rotation is deliberately disabled in
this app (`robot:795-797`). Continuous translation (forward/back until stopped) is
allowed with a 5 s deadman (`robot:788-834`).

### Stop

Write `00 00` to `0xFED0` (`sdk:321-323`). This repo treats stop as idempotent and
sends it on every motion-end path (duration complete, safety stop, disconnect,
app background) — e.g. `robot:666-673`, `robot:837-869`, `autoconnect:80-83`.

---

## 4. Head, light, dance, sleep

### Head (`0xFED1`, 1 byte, write-without-response)

| Position | Byte | Source |
|---|---|---|
| up | `00` | `sdk:34` |
| center | `87` | `sdk:35` |
| down | `ff` | `sdk:36` |

`87` for "center" and the `00`/`ff` extremes are magic values; the code gives no
angle semantics or units. The SDK also accepts an arbitrary raw byte 0–255 passed
through verbatim (`sdk:329-331`) — whether intermediate values are valid angles is
**not confirmed**; only the three named positions are exercised by this codebase.

Head *gestures* are application-layer compositions of those three bytes with
delays (`robot:884-932`):

| Gesture | Sequence | Source |
|---|---|---|
| nod (×1–5) | up → 280 ms → down → 390 ms → center (per repetition) | `robot:888-897` |
| curious | up → 420 ms → center | `robot:898-902` |
| happy_bob | up → 180 → down → 180 → up → 180 → center | `robot:903-911` |
| sleepy | down → 550 ms → center | `robot:912-916` |
| thinking | down → 300 ms → center | `robot:917-921` |
| speaking_soft | up → 150 ms → center | `robot:922-926` |

### Light (`0xFED2`, 1 byte, write-**with**-response)

| State | Byte | Source |
|---|---|---|
| on | `01` | `sdk:40` |
| off | `00` | `sdk:41` |

There is **no color or brightness encoding anywhere in this codebase** — the light
is a boolean. If the hardware supports color, this repo has never exercised it.

### Dance

There is **no device-side dance opcode**. `performLooiDance` is application-layer
choreography built from §3 turns and §4 head gestures (`robot:1033-1081`):

| Style | Composition | Source |
|---|---|---|
| `bounded-wiggle-v1` | happy_bob → left 90° → nod → right 180° → happy_bob → left 90° (return) → nod ×2 | `robot:1039-1050` |
| `happy-sway-v1` | happy_bob → left 90° → right 90° → happy_bob → nod | `robot:1051-1059` |
| `silly-shake-v1` | curious → left 160 ms → right 320 ms → left 160 ms → happy_bob | `robot:1060-1070` |

(90°/180° turns use the calibrated 650/1560 ms durations from §3.)

Character-reaction sequences (startled / pleased / annoyed / angry / victory) are
further compositions of the same primitives (`robot:960-1014`).

### Sleep

There is **no device-side sleep command**. "Sleep" in this app is a chain
(`sleep:9-25`):

1. stop motion (`sleep:14`),
2. head `sleepy` gesture — down, 550 ms, center (`sleep:15-17`, `robot:912-916`),
3. mark app state and pause the runtime, which suspends autoconnect and drops the
   BLE link (`sleep:22-23` → `bootstrap:103,126` → `autoconnect:116-125`).

Waking is physical: a single tap on the robot's face (`sleep:24`, `sleep:27-39`).
**[empirical]** Once asleep the robot stops advertising (§1), so a sleeping robot
cannot be reconnected by any client until physically woken.

---

## 5. Sensor readback (`0xFED9` notifications)

FED9 is an **event stream, not a heartbeat**: frames arrive on change, and real
captures can space notifications ~5 s apart (`robot:27`, `robot:419-423`). After a
fresh connect the first frame can lag the GATT connect by tens of milliseconds;
this repo waits up to 700 ms for the first frame before judging the stream
(`robot:20`, `robot:563-603`). Firmware does not reliably emit a cliff frame on
every connection (`robot:419-423`).

Frame decoder (`fed9:37-69`), calibrated against a real unit on 2026-08-16
(`fed9:23-26`):

| Frame | Meaning | Source |
|---|---|---|
| 1 byte: `05` | docked | `fed9:38`, `sdk:44-47` |
| 1 byte: `06` | undocked | `fed9:39`, `sdk:44-47` |
| 5 bytes, **every** byte ∈ {`00`,`01`}: `[marker, FL, FR, RL, RR]` | downward cliff sensors; `01` = ground/safe, `00` = edge/unsafe; order = front-left, front-right, rear-left, rear-right; `marker` = first byte, semantics unknown | `fed9:41-56` |
| 3 bytes: `0e XX XX` | front TOF distance, `uint16` **little-endian**, unit mm; `0x1fff` = no target | `fed9:58-65`, `fed9:2` |
| anything else | unknown frame type — decoder returns `unknown` and the value is retained only as raw hex | `fed9:68`, `robot:40` |

Notes:

- The 5-byte cliff frame only decodes if *all five* bytes are 0 or 1 (`fed9:41`) —
  any other value makes it an unknown frame, not a cliff frame.
- The marker byte's semantics are deliberately excluded from the safe/unsafe
  decision; controlled tests only established the four directional sensors
  (`fed9:31-35`).
- The 180 mm "obstacle near" threshold is an **application-layer** choice
  (`fed9:1`, `fed9:64`), not a device constant.
- **[empirical]** Some units (including the one this repo was built against) never
  emit a TOF frame for an entire connection — zero `0e` frames across every capture
  since 2026-08 (`robot:441-449`). Do not build a client that hard-fails without
  TOF data.

---

## 6. Safety interlocks (application layer — **not** enforced by the device)

The device accepts drive frames unconditionally; everything in this section is
this repo's `computeSafety` and notification handling (`robot:397-469`,
`robot:1084-1225`). An external implementation should treat this as one proven
design, not a protocol requirement.

- **Directional cliff gating**: forward requires front-left + front-right safe;
  back requires rear-left + rear-right; any turn requires all four
  (`robot:369-376`, `robot:427-439`).
- **Near-edge latch**: a cliff seen *while moving* latches that side; a single
  transient SAFE frame does not clear it. The latch clears only after the robot
  drives away from the edge (opposite direction) with all sensors safe for 650 ms
  (`robot:24`, `robot:304-367`, rationale `robot:403-417`).
- **Re-arm debounce**: after unsafe, motion re-enables only after the required
  sensors stay safe for 250 ms (`robot:23`, `robot:386-395`).
- **TOF obstacle**: a decoded obstacle ≤ 180 mm blocks forward and triggers an
  immediate stop (`robot:450-453`, `robot:1189-1191`). A *never-reporting* TOF
  fails open — missing data must not paralyze forward, but a decoded obstacle
  still hard-blocks (`robot:441-449`).
- **No FED9 at all ⇒ unknown ⇒ movement blocked**: before the first FED9 frame the
  safety state is `unknown` and all motion is refused (`robot:424-426`,
  `robot:605-630`).
- **Deadman**: continuous translation auto-stops after 5 s without a re-issue
  (`robot:26`, `robot:1234-1254`).
- **Manual recovery**: a latched near-edge that leaves no legal direction can be
  cleared only after physical repositioning plus 900 ms of all-four-sensors stable
  (`robot:25`, `robot:251-279`).

---

## 7. Minimal standalone example (Web Bluetooth, no dependencies)

Every byte below traces to §2 (handshake) and §3 (drive frames). This mirrors the
SDK's own Web Bluetooth transport (`sdk:390-498`), which uses the same service,
characteristics, name filter, and write modes.

```js
// LOOI: connect -> handshake -> forward 700 ms -> stop.
const SERVICE = 0x00ff; // §1: 000000ff-0000-1000-8000-00805f9b34fb
// Web Bluetooth accepts full 128-bit UUID strings; use them directly:
const CH = {
  drive: "0000fed0-0000-1000-8000-00805f9b34fb", // §1
  fed9:  "0000fed9-0000-1000-8000-00805f9b34fb", // §1, §5
  feda:  "0000feda-0000-1000-8000-00805f9b34fb", // §1, §2
  fef0:  "0000fef0-0000-1000-8000-00805f9b34fb", // §1, §2
};
const DRIVE = { // §3, opaque 2-byte magic constants
  forward: [0x77, 0x07],
  back:    [0x86, 0xfc],
  left:    [0x04, 0x7a],
  right:   [0x00, 0x82],
  stop:    [0x00, 0x00],
};
const KEEPALIVE_MS = 110; // §3
const MOVE_MS = 700;      // §3 host-side duration

// §2: 20 ASCII bytes "A{YYYY} {MM} {DD} {HH} {mm} {ss}"
function initTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const s = `A${d.getFullYear()} ${p(d.getMonth() + 1)} ${p(d.getDate())} ` +
            `${p(d.getHours())} ${p(d.getMinutes())} ${p(d.getSeconds())}`;
  return Uint8Array.from(s, (c) => c.charCodeAt(0)); // exactly 20 bytes
}

// 1. Connect (name filter per §1)
const device = await navigator.bluetooth.requestDevice({
  filters: [{ name: "LOOI Robot" }],
  optionalServices: [SERVICE],
});
const server = await device.gatt.connect();
const svc = await server.getPrimaryService(SERVICE);
const drive = await svc.getCharacteristic(CH.drive);
const feda  = await svc.getCharacteristic(CH.feda);
const fef0  = await svc.getCharacteristic(CH.fef0);
const fed9  = await svc.getCharacteristic(CH.fed9);

// 2. Sensor notifications (§5) — optional but recommended.
await fed9.startNotifications();
fed9.addEventListener("characteristicvaluechanged", (e) => {
  const b = new Uint8Array(e.target.value.buffer);
  console.log("FED9:", [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "));
});
await fef0.startNotifications(); // handshake replies, e.g. 0x59 'Y' [empirical, §2]

// 3. Handshake (§2): three writes, each acknowledged at GATT level.
await feda.writeValueWithResponse(Uint8Array.of(0x03));          // step 1
await fef0.writeValueWithResponse(initTime());                   // step 2 (20 bytes)
await feda.writeValueWithResponse(Uint8Array.of(0x81, 0x01));    // step 3
// If your unit exposes no FEDA/FEF0 at all, skip the three writes (§2 firmware note).

// 4. Forward 700 ms (§3): first frame goes out immediately, then the timer
// re-sends it every 110 ms (SDK does exactly this, sdk:297), then stop.
await drive.writeValueWithoutResponse(Uint8Array.of(...DRIVE.forward));
const timer = setInterval(
  () => drive.writeValueWithoutResponse(Uint8Array.of(...DRIVE.forward)),
  KEEPALIVE_MS,
);
await new Promise((r) => setTimeout(r, MOVE_MS));
clearInterval(timer);
await drive.writeValueWithoutResponse(Uint8Array.of(...DRIVE.stop));
```

The same flow on Node with `@abandonware/noble` is a mechanical translation:
discover services/characteristics by the UUIDs in §1, use
`writeWithoutResponse`-equivalent for `FED0` writes and response-acknowledged
writes for `FEDA`/`FEF0`/`FED2` (§1 write-mode table).

---

## 8. Known pitfalls

### Dead-link recovery ladder

Observed failure: after a link loss the robot can keep a stale GATT session that
accepts nothing; worse, Android can report "already connected" for a dead link.
The recovery ladder this repo converged on:

1. On any BLE failure, mark the drive channel invalid, kill the move loop, and
   **fully disconnect** the robot client — `disconnect()` also clears the SDK's
   handshake-complete state, forcing the next connect into a real reconnect
   instead of stale GATT reuse (`robot:165-191`, `robot:1312-1320`).
2. Adopt Android's "already connected" state instead of fighting it: rediscover
   GATT and re-subscribe notifications (`transport:125-149`).
3. After **every** reconnect, re-validate the `FED0` channel by writing the STOP
   frame (`00 00`) with a 900 ms deadline, then wait 120 ms settle, before any
   movement is allowed (`robot:521-541`, `robot:19`, `robot:21`).
4. Foreground-only auto-retry: 700 ms after link loss (`autoconnect:247-253`),
   and 1 000 ms for transient first-reconnect cancellations after deep sleep
   (`autoconnect:29`, `autoconnect:137-143`).
5. Going to background always sends an emergency stop before suspending
   (`autoconnect:71-84`).
6. **[empirical]** When the ladder fails, the robot itself can hold the dead link
   and only a physical restart of the robot recovers it.

### Official app / sleep occupancy

**[empirical]** A robot claimed by the official LOOI app — or asleep — stops
advertising (§1, §4). If your scan finds nothing, check those two before blaming
your scanner.

### Invisible writes in Android logs

**[empirical]** logcat shows GATT write events without the payload bytes, so
Android system logs cannot confirm which frame you actually sent. Verify on the
robot's behavior (wheels/head/light), or capture on-air, not via logcat.

### TOF silence

**[empirical]** Some units never report TOF (§5). A client that hard-requires `0e`
frames will consider a healthy robot broken.

### Single-frame motion is unproven

The SDK always loops frames at 110 ms (§3); whether one lone frame produces
wheel motion, and for how long, was never tested and is not documented in code.
Keep the keepalive loop.

---

## 9. Items that cannot be confirmed from code

1. **Per-byte semantics of the drive constants** `77 07 / 86 fc / 04 7a / 00 82 /
   00 00` — opaque magic values (`sdk:25-31`). No speed/duration/checksum
   interpretation exists anywhere in the repo.
2. **Head angle semantics** of `00 / 87 / ff` — named positions only; whether the
   raw-byte pass-through range (`sdk:329-331`) maps to real angles is untested.
3. **Light color/brightness** — no code support at all; boolean only (`sdk:39-42`).
4. **Purpose of `0xFE00`** — enumerated (`transport:35`, `sdk:12`); runtime
   code never touches it, but the SDK README has one unexplained 20-byte
   raw-write example (`packages/looi-sdk/README.md:57`).
5. **Handshake reply payloads** — code sends the three writes and never reads or
   validates any reply (`sdk:271-281`); the `0x59 'Y'` marker on `FEF0` is
   empirical only. Per-byte meaning of `03` and `81 01` is unknown.
6. **Device-side keepalive expiry** — how long one drive frame moves the wheels
   without a repeat (see §8).
7. **BLE connection parameters** (interval, latency, supervision timeout) — never
   set or logged in code; only the Android MTU-185 request exists
   (`transport:180-184`), and why 185 is undocumented.
8. **Cliff marker byte semantics** (`fed9:31-35`).
9. **Whether the FED9 frame set is exhaustive** — the decoder returns `unknown`
   for anything unrecognized (`fed9:68`); other frame types may exist.
