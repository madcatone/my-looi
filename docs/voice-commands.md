# Voice command reference

How spoken movement commands reach the wheels, and the exact phrases the
deterministic parser accepts. Everything here is enforced in
`src/voice/explicit-robot-command.ts` (parsing) and
`src/voice/realtime-physical-command.ts` (realtime session routing).

## How interception works

During a realtime voice session (OpenAI Realtime or Gemini Live) the model has
**no movement tool** by design (`src/voice/realtime-config.ts`). Wheel commands
are intercepted locally from the input transcription, in this order:

1. **Emergency stop** — global, no address needed, highest priority.
2. **Addressed command** — the utterance must start with a robot address
   (`parseExplicitRobotCommand`). This is a strict keyword gate (user
   decision, v2.1.159): without an address nothing triggers and the utterance
   goes to the model. A hit executes the motion locally, cancels the model's
   response (`response.cancel`), and acknowledges via local TTS — the cloud
   model never answers a command.
3. Anything else goes to the LLM, which will correctly answer that it can only
   chat. If the robot "refuses to move", the utterance missed the address
   gate — check the `[RealtimeCmd] transcript=… physical=…` console line in
   logcat to see what the provider actually transcribed.

## Addresses

Built-in: `LOOI`, `Louie`, `Louis`, `Lewis`, `Loui`, `Looey`, `Look`, `Lou`,
`Luke`, `Blue Eye`, `Robot`, `Max`, plus the Russian/Ukrainian family (`Луи`
variants, `Макс`, `Робот`, …). The user's configured robot name and aliases
are accepted alongside the built-ins (longest match wins). The English list
is deliberately wide: Gemini Live has no STT
biasing, and the same spoken "LOOI" transcribes nondeterministically across
the /lu/-initial family (on-device logs for one utterance produced *Louis*,
*Look* and *Lewis* on consecutive attempts). Aliases are only honored in the
address position — `Look` behaves as an address solely when the remainder
parses as a physical command, so `look here` / `look at this` still reach the
visual look-here parser (which runs after physical interception). A glued
address (no space before the command, e.g. `Looiturn around`) is split when
the remainder starts with a known command stem.

## Addressed movement commands

After the address, polite lead-ins (`please`, `okay`, `ok`, and the Russian
fillers `давай`, `окей`, …) are stripped, up to three in a row. `<verb>` is
optional when the direction word stands alone: `LOOI, forward` and `LOOI, go
forward` both work.

| Action | English | Notes |
|---|---|---|
| Forward | `forward`, `ahead`, `straight` (optionally `go/drive/move …`) | bounded move |
| Backward | `back`, `backward`, `reverse` (optionally `go/drive/move …`) | bounded move |
| Turn left | `left` (optionally `turn/move left`) | 90° calibrated |
| Turn right | `right` (optionally `turn/move right`) | 90° calibrated |
| Turn 180° | `turn around`, `turn back around`, `make a u-turn`, `u-turn`, or `180` / `one eighty` / `one hundred (and) eighty` (optionally `+ degrees`, optionally with `turn/rotate`) | clockwise is the fixed default |
| Stop | `stop`, `halt` | |

Russian/Ukrainian equivalents (`вперёд`, `назад`, `налево`, `направо`,
`развернись`, `стоп`, …) follow the same table; see the regexes in
`explicit-robot-command.ts` for the full word lists.

Non-movement physical commands use the same addressed shape: `sleep`
(`go to sleep`, `fall asleep`), `dance`, `nod` (`nod your head`, optional
count 1–5).

## Addressless utterances

Inside a voice session, an utterance **without** an accepted address never
moves the robot — it goes to the model as conversation. (v2.1.154 briefly
accepted addressless verb-led imperatives and v2.1.158 tolerated one
unrecognized leading word; both were reverted by user decision in v2.1.159 in
favor of a strict, predictable keyword gate. The alias family above is the
keyword — "Zoe go back" works because `zoe` is an alias, not because unknown
words are tolerated.)

## Emergency stop

`stop` (and Russian `стоп`), spoken at any time with or without an address,
stops motion immediately. User-configured emergency phrases
(settings → custom voice commands) are honored for the active listening
language. This is the only command class that is truly global.

## Movement characteristics

- Forward/backward: bounded (~700 ms) moves — the robot stops on its own;
  no follow-up stop command is needed.
- Turns: calibrated durations (90° / 180°); 180° turns clockwise.
- Cliff/TOF sensor interlocks remain active during all voice-initiated motion.
