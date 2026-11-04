import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  module._compile(output, filename);
};

function compileTs(file) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(path.resolve(file));
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    localRequire,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const protocol = compileTs("src/gemini/gemini-live-protocol.ts");
const models = compileTs("src/gemini/gemini-live-models.ts");
const realtime = compileTs("src/voice/realtime-config.ts");

// 1. Documented endpoint + API-key query-parameter auth + PCM rates.
assert.equal(
  protocol.buildGeminiLiveWebSocketUrl("AIzaTESTKEY123456789012345"),
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=AIzaTESTKEY123456789012345"
);
assert.equal(protocol.GEMINI_LIVE_INPUT_PCM_MIME_TYPE, "audio/pcm;rate=16000");
assert.equal(protocol.GEMINI_LIVE_OUTPUT_PCM_RATE, 24_000, "Gemini output is 24 kHz PCM and must match the native playback path");

// 2. session.update -> BidiGenerateContentSetup, translated from the real config builder output.
const sessionUpdate = realtime.buildRealtimeSessionUpdate({
  language: "ru",
  listeningLanguage: "uk",
  ttsVoiceId: "fable",
  ttsSpeed: 1.15,
});
const state = protocol.createGeminiLiveAdapterState();
const setupMessages = protocol.openAiEventToGeminiMessages(sessionUpdate, state, "gemini-3.1-flash-live-preview");
assert.equal(setupMessages.length, 1);
const setup = setupMessages[0].setup;
assert.equal(setup.model, "models/gemini-3.1-flash-live-preview");
assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
assert.equal(setup.systemInstruction.parts[0].text, sessionUpdate.session.instructions);
assert.equal(setup.tools.length, 1);
const declarations = setup.tools[0].functionDeclarations;
assert.deepEqual(
  declarations.map((declaration) => declaration.name).sort(),
  ["remember", "search_memory", "set_language_preferences"]
);
assert.equal(declarations[0].parameters.additionalProperties, undefined, "OpenAI-only schema keywords must not reach Gemini declarations");
assert.equal(declarations[0].parameters.type, "object");
assert.equal(Boolean(declarations[0].parameters.properties.query), true, "search_memory parameters must keep their field definitions");
assert.deepEqual(setup.inputAudioTranscription.languageCodes, ["uk"]);

// Setup is once per connection: a mid-session preferences update is dropped.
assert.equal(
  protocol.openAiEventToGeminiMessages(sessionUpdate, state, "gemini-3.1-flash-live-preview").length,
  0,
  "second session.update must not try to reconfigure a live Gemini session"
);

// 3. Mic uplink: 16 kHz native rate passthrough (no 24 kHz resample on Gemini).
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({ type: "input_audio_buffer.append", audio: "QUJD" }, state, "m"),
  [{ realtimeInput: { audio: { data: "QUJD", mimeType: "audio/pcm;rate=16000" } } }]
);

// 4. Cancel interrupts via the documented turnComplete=true; truncate is server-side already.
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({ type: "response.cancel" }, state, "m"),
  [{ clientContent: { turns: [], turnComplete: true } }]
);
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({ type: "conversation.item.truncate", item_id: "x", content_index: 0, audio_end_ms: 120 }, state, "m"),
  []
);

// 5. Photo-context flow: buffered user parts flush as one clientContent turn.
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "SELECTED PHOTO 1 OF 1" },
        { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=", detail: "high" },
      ],
    },
  }, state, "m"),
  []
);
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({ type: "response.create" }, state, "m"),
  [{
    clientContent: {
      turns: [{
        role: "user",
        parts: [
          { text: "SELECTED PHOTO 1 OF 1" },
          { inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
        ],
      }],
      turnComplete: true,
    },
  }]
);
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({ type: "response.create" }, state, "m"),
  [],
  "bare response.create must no-op (Gemini continues automatically after tool responses)"
);

// 6. Tool round trip: server toolCall -> OpenAI function_call item; client output -> toolResponse.
const toolEvents = protocol.geminiServerMessageToOpenAiEvents(
  { toolCall: { functionCalls: [{ id: "call-7", name: "remember", args: { note: "likes robots" } }] } },
  state
);
assert.deepEqual(toolEvents, [{
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "function_call", id: "call-7", call_id: "call-7", name: "remember", arguments: JSON.stringify({ note: "likes robots" }) },
}]);
assert.deepEqual(
  protocol.openAiEventToGeminiMessages({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "call-7", output: JSON.stringify({ ok: true }) },
  }, state, "m"),
  [{ toolResponse: { functionResponses: [{ id: "call-7", name: "remember", response: { result: { ok: true } } }] } }]
);

// 7. setupComplete handshake and exactly-once response lifecycle per turn.
const fresh = protocol.createGeminiLiveAdapterState();
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents({ setupComplete: {} }, fresh).map((event) => event.type),
  ["session.created", "session.updated"]
);
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents(
    { serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] } } },
    fresh
  ).map((event) => event.type),
  ["response.created", "response.output_item.added", "response.content_part.added", "response.output_audio.delta"]
);
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents(
    { serverContent: { modelTurn: { parts: [{ inlineData: { data: "BBBB" } }] } } },
    fresh
  ).map((event) => event.type),
  ["response.output_audio.delta"],
  "no second response.created within one model turn"
);
const doneEvents = protocol.geminiServerMessageToOpenAiEvents({ serverContent: { generationComplete: true } }, fresh);
assert.deepEqual(doneEvents.map((event) => event.type), ["response.output_audio.done", "response.done"]);
assert.equal(doneEvents[1].response.status, "completed");
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents({ serverContent: { turnComplete: true } }, fresh).map((event) => event.type),
  [],
  "turnComplete after generationComplete must not duplicate response.done"
);

// 8. Barge-in: interrupted -> speech_started + single incomplete response.done (docs: "interrupted > turn_complete").
const barge = protocol.createGeminiLiveAdapterState();
protocol.geminiServerMessageToOpenAiEvents({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } }, barge);
const interruptedEvents = protocol.geminiServerMessageToOpenAiEvents({ serverContent: { interrupted: true } }, barge);
assert.deepEqual(interruptedEvents.map((event) => event.type), ["input_audio_buffer.speech_started", "response.done"]);
assert.equal(interruptedEvents[1].response.status, "incomplete");
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents({ serverContent: { turnComplete: true } }, barge).map((event) => event.type),
  []
);

// 9. User transcript: incremental segments; finished=true emits exactly one completed event.
const transcriptState = protocol.createGeminiLiveAdapterState();
assert.deepEqual(
  protocol.geminiServerMessageToOpenAiEvents({ serverContent: { inputTranscription: { text: "Луи, " } } }, transcriptState).map((event) => event.type),
  []
);
const finalSegment = protocol.geminiServerMessageToOpenAiEvents(
  { serverContent: { inputTranscription: { text: "наклонись", finished: true } } },
  transcriptState
);
assert.deepEqual(finalSegment.map((event) => event.type), ["conversation.item.input_audio_transcription.completed"]);
assert.equal(finalSegment[0].transcript, "Луи, наклонись");
const afterTurn = protocol.geminiServerMessageToOpenAiEvents(
  { serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } } },
  transcriptState
);
assert.equal(
  afterTurn.some((event) => event.type === "conversation.item.input_audio_transcription.completed"),
  false,
  "closed transcript must not re-emit on the following model turn"
);
assert.equal(protocol.appendTranscriptSegment("Луи", "Луи, наклонись"), "Луи, наклонись", "cumulative upstream segments must not duplicate text");
assert.equal(protocol.appendTranscriptSegment("Луи", ", наклонись"), "Луи, наклонись", "incremental upstream segments must concatenate");

// 10. Fixed model list from the official Live docs.
assert.equal(models.DEFAULT_GEMINI_LIVE_MODEL_ID, "gemini-3.1-flash-live-preview");
assert.deepEqual(models.GEMINI_LIVE_MODEL_OPTIONS.map((option) => option.id), [
  "gemini-3.1-flash-live-preview",
  "gemini-3.8-live",
  "gemini-2.5-flash-native-audio-preview-12-2025",
]);
assert.equal(models.normalizeGeminiLiveModelId("gpt-realtime-2.1-mini"), "gemini-3.1-flash-live-preview");
assert.equal(models.normalizeGeminiLiveModelId("gemini-3.8-live"), "gemini-3.8-live");

// 11. Wiring: Gemini rides the shared PCM service; the OpenAI path stays intact.
const pcmSource = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
assert.ok(pcmSource.includes("createOpenAiRealtimeEphemeralWebSocket"), "OpenAI ephemeral WebSocket transport must remain");
assert.ok(pcmSource.includes("createGeminiLiveTransport"), "Gemini transport must be wired into the PCM service");
assert.ok(
  pcmSource.includes('this.provider === "gemini" ? gainedSamples : resample16kTo24k(gainedSamples)'),
  "Gemini uplink must stay native 16 kHz; OpenAI must keep its 24 kHz resample"
);
const keySource = fs.readFileSync("src/openai/openai-api-key.ts", "utf8");
assert.ok(keySource.includes("wss://api.openai.com/v1/realtime?model="), "OpenAI Realtime endpoint must remain unchanged");
assert.equal(keySource.includes("generativelanguage"), false, "OpenAI key module must not gain Gemini concerns");
const storeSource = fs.readFileSync("src/store/user.ts", "utf8");
assert.ok(storeSource.includes('realtimeProvider: "openai"'), "OpenAI must remain the default provider");
assert.ok(storeSource.includes("normalizeGeminiLiveModelId"), "persisted Gemini model ids must normalize to the fixed list");
const geminiKeySource = fs.readFileSync("src/gemini/gemini-api-key.ts", "utf8");
assert.ok(geminiKeySource.includes("SecureStore.setItemAsync"));
assert.ok(geminiKeySource.includes('"looi.gemini-api-key.v1"'));
assert.equal(geminiKeySource.includes("sk-"), false, "no secret literals in the Gemini key module");
const transportSource = fs.readFileSync("src/gemini/gemini-live-transport.ts", "utf8");
assert.equal(transportSource.includes("@google/genai"), false, "Gemini Live must ride the raw RN WebSocket, not the SDK");
const settingsSource = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
assert.ok(settingsSource.includes('realtimeProvider: "gemini"'), "settings must offer the Gemini provider switch");
assert.ok(settingsSource.includes("GEMINI_LIVE_MODEL_OPTIONS"), "settings must render the fixed Gemini model list");

// 12. Onboarding: step 1 is provider-aware; either provider key satisfies the readiness gate.
const readinessSource = fs.readFileSync("src/setup/setup-readiness.ts", "utf8");
assert.ok(readinessSource.includes("hasGeminiApiKey()"), "readiness must probe the Gemini SecureStore key");
assert.ok(
  readinessSource.includes("const voiceKeyConfigured = openAiKeyConfigured || geminiKeyConfigured;"),
  "any provider key must satisfy the voice-key readiness gate"
);
assert.ok(
  readinessSource.includes("const requiredReady = voiceKeyConfigured && modelsReady && microphoneReady;"),
  "onboarding completion must not hard-require the OpenAI key"
);
const onboardingSource = fs.readFileSync("app/onboarding.tsx", "utf8");
assert.ok(onboardingSource.includes("saveGeminiApiKey(validateGeminiApiKey"), "onboarding must validate+save the Gemini key");
assert.ok(onboardingSource.includes("clearGeminiApiKey()"), "onboarding must delete the Gemini key");
assert.ok(onboardingSource.includes('updatePreferences({ realtimeProvider: "gemini" })'), "onboarding step 1 must offer the provider switch");
assert.ok(onboardingSource.includes('updatePreferences({ realtimeProvider: "openai" })'), "onboarding step 1 must allow switching back to OpenAI");
assert.ok(onboardingSource.includes('return readiness.voiceKeyConfigured;'), "step-1 completion must track either provider key");
assert.ok(onboardingSource.includes("settings.geminiKeyHelp"), "Gemini branch must render the localized Gemini help text");
assert.ok(onboardingSource.includes("settings.voiceProvider"), "step title/chip must use the localized provider label");
assert.equal(onboardingSource.includes('Section title="OpenAI Realtime"'), false, "step 1 must not hardcode the OpenAI-only section");
assert.equal(onboardingSource.includes("Google AI Studio API key"), true, "Gemini branch must hint where the key comes from");

console.log("Gemini Live provider behavior: PASS");
