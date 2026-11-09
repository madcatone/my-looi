import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 164);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 164);

// Regression: after a locally-executed physical command the robot moved, but
// the cloud model still replied "I can't turn left" over the local ack — a
// split-brain turn. Two causes, both fixed in v2.1.164:
//
//   1. The Gemini adapter translated response.cancel into clientContent
//      {turns:[], turnComplete:true}. In the Live API clientContent IS user
//      input, so turnComplete=true means "the user finished speaking — please
//      respond": every "cancel" actively prompted the model to comment on the
//      command utterance sitting in context.
//   2. Suppression was only a time window (localPhysicalCommandInFlight,
//      cleared when execution finished ~700ms later). A model generation
//      that started after the interception — or was prompted by the bogus
//      cancel — streamed its audio once the window closed.

const pcm = read("src/voice/realtime-pcm-conversation.ts");
const gemini = read("src/gemini/gemini-live-protocol.ts");

// 1. The Gemini translation of response.cancel must emit NOTHING.
assert.match(
  gemini,
  /if \(type === "response\.cancel"\) \{[\s\S]*?return \[\];[\s\S]*?\}/,
  "response.cancel must translate to zero Gemini messages"
);
assert.ok(
  !gemini.includes("clientContent: { turns: [], turnComplete: true } }"),
  "clientContent must never be used as a cancel — it is user input"
);

// 2. Turn-scoped suppression exists and is wired at every model-output gate.
assert.ok(pcm.includes("private suppressModelOutputUntilNextUserTranscript = false;"));
for (const gate of [
  'if (type === "response.output_audio.delta") {',
  'if (type === "response.output_audio_transcript.delta") {',
  'if (type === "response.output_audio_transcript.done") {',
]) {
  const at = pcm.indexOf(gate);
  assert.ok(at >= 0, `gate missing: ${gate}`);
  const window = pcm.slice(at, at + 260);
  assert.ok(window.includes("this.suppressModelOutputUntilNextUserTranscript"), `${gate} must check the turn-scoped suppression flag`);
}
assert.ok(
  pcm.includes('if (this.localPhysicalCommandInFlight || this.localVisualCommandInFlight || this.suppressModelOutputUntilNextUserTranscript) return;'),
  "response.done must skip finalize while the command owns the turn"
);

// 3. The flag is set on BOTH interception paths and cleared on the next user
//    transcript + session reset.
{
  const physAt = pcm.indexOf("this.localPhysicalCommandInFlight = true;");
  const visAt = pcm.indexOf("this.localVisualCommandInFlight = true;");
  assert.ok(pcm.slice(physAt, physAt + 120).includes("this.suppressModelOutputUntilNextUserTranscript = true;"), "physical interception must arm suppression");
  assert.ok(pcm.slice(visAt, visAt + 120).includes("this.suppressModelOutputUntilNextUserTranscript = true;"), "visual interception must arm suppression");
  const clearAt = pcm.indexOf("this.userTranscriptItems.add(itemId);");
  assert.ok(pcm.slice(clearAt, clearAt + 300).includes("this.suppressModelOutputUntilNextUserTranscript = false;"), "next user transcript must clear suppression");
}

// 4. Chain hygiene.
assert.ok(pkg.scripts.test.includes("v2.1.164-gemini-cancel-no-poke-regression.test.mjs"), "this test must be part of the npm test chain");
for (const part of pkg.scripts.test.split(" && ")) {
  assert.ok(!/\.mjs["']/.test(part), `test chain command has a stray quote: ${part}`);
}

console.log("v2.1.164 Gemini cancel no-poke + turn-scoped suppression: PASS");
