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
2. **Addressed command** — utterance must start with a robot address
   (`parseExplicitRobotCommand`).
3. **In-session command** (v2.1.154) — inside a live session, whole-utterance
   verb-led imperatives without an address (`parseSessionRobotCommand`).
4. Anything else goes to the LLM, which will correctly answer that it can only
   chat. If the robot "refuses to move", the utterance missed all three gates —
   check the `[RealtimeCmd] transcript=… physical=…` console line in logcat.

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

## In-session commands (addressless)

Inside an already-open voice session the wake gesture replaces the spoken
address, so whole-utterance verb-led imperatives are accepted **without** one:

- `go / drive / move` + `forward / ahead / straight`
- `go / drive / move / come` + `back / backward / reverse`
- `turn / rotate / spin` + `left / right`
- `turn / rotate / spin` + `180 / one eighty / one hundred (and) eighty`
  (optionally `+ degrees`)
- `turn around`, `turn back around`, `make a u-turn`, `u-turn`

Safety rules that keep this from firing on conversation:

- The **entire utterance** must match — `let's go forward with the plan`
  fails, `go forward` passes.
- A verb is required — bare `right` or `forward` is not a command.
- Bare numbers are rejected — answering `180` to a chat question never moves
  the robot.
- Custom phrases keep their addressed requirement even in-session.
- Since v2.1.158, **one unrecognized leading word is tolerated** when the
  remainder is an exact imperative (`Zoe go back` fires). STT renders the
  wake name nondeterministically (louie/louis/look/lewis/blue eye/zoe/dui/…)
  and the family cannot be enumerated. Exactly one word is stripped and the
  remainder must still match the anchored grammar, so `honey go back to
  sleep`, `Zoe 180` and `the dogs turn left` all still miss.

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
