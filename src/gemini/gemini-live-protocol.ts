/**
 * Pure event-translation layer between the app's OpenAI Realtime event
 * dialect and the Gemini Live API BidiGenerateContent wire format.
 *
 * Everything here is a pure function over plain objects with no React Native
 * imports so scripts/*.test.mjs can execute it directly under Node.
 *
 * Wire facts confirmed against the official documentation:
 * - Endpoint: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *   with the API key as a `key` query parameter
 *   (https://aistudio.google.com/docs/live-api/get-started-websocket — Authentication).
 * - Input audio: raw 16-bit PCM, little-endian, 16 kHz, sent as
 *   realtimeInput.audio = { data: base64, mimeType: "audio/pcm;rate=16000" }.
 *   Input is natively 16 kHz; the server resamples other rates.
 * - Output audio: always raw 16-bit PCM at 24 kHz (matches REALTIME_PCM_RATE
 *   and the native playback path; no output resampling is needed).
 * - The first client message must be the setup; later session updates cannot
 *   reconfigure a live session (docs: "first (and only in the first)").
 * - clientContent with turnComplete=true "unconditionally interrupts
 *   generation" — used to translate response.cancel.
 * - serverContent.interrupted means the server already cut the model output
 *   and the client should stop and empty its playback queue.
 * - Transcription segments arrive incrementally; the final segment may carry
 *   finished=true (official example: gemini-live-ephemeral-tokens-websocket).
 */

export const GEMINI_LIVE_WEBSOCKET_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const GEMINI_LIVE_INPUT_PCM_RATE = 16_000;
export const GEMINI_LIVE_INPUT_PCM_MIME_TYPE = "audio/pcm;rate=16000";
export const GEMINI_LIVE_OUTPUT_PCM_RATE = 24_000;

type AnyRecord = Record<string, any>;

export type GeminiLiveAdapterState = {
  /** Client side: the one-time setup has been sent for this connection. */
  setupSent: boolean;
  /** Client side: user parts buffered between conversation.item.create and response.create. */
  pendingUserParts: AnyRecord[];
  /** Server side: a model turn is currently being synthesized into OpenAI events. */
  responding: boolean;
  /** Monotonic counters for synthetic OpenAI ids. */
  turnCounter: number;
  inputTranscriptItemSeq: number;
  /** Server side: accumulated user (input) and assistant (output) transcripts. */
  inputTranscript: string;
  inputTranscriptClosed: boolean;
  outputTranscript: string;
  /** toolCall id -> function name, so tool responses can echo the name. */
  toolNames: Map<string, string>;
};

export function createGeminiLiveAdapterState(): GeminiLiveAdapterState {
  return {
    setupSent: false,
    pendingUserParts: [],
    responding: false,
    turnCounter: 0,
    inputTranscriptItemSeq: 0,
    inputTranscript: "",
    inputTranscriptClosed: false,
    outputTranscript: "",
    toolNames: new Map(),
  };
}

export function buildGeminiLiveWebSocketUrl(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) throw new Error("Gemini API key is empty");
  return `${GEMINI_LIVE_WEBSOCKET_BASE}?key=${encodeURIComponent(key)}`;
}

/**
 * Gemini function declarations accept an OpenAPI-schema subset. Copy the
 * supported keywords recursively and drop everything else (for example
 * additionalProperties) so OpenAI-shaped tool parameters are always accepted.
 */
function toGeminiSchemaValue(value: any): any {
  if (Array.isArray(value)) return value.map(toGeminiSchemaValue);
  if (!value || typeof value !== "object") return value;
  const out: AnyRecord = {};
  for (const key of ["type", "description", "required", "items", "enum", "format", "nullable"]) {
    if (value[key] !== undefined) out[key] = toGeminiSchemaValue(value[key]);
  }
  if (value.properties && typeof value.properties === "object") {
    // `properties` maps arbitrary field names to nested schemas; keep every
    // field name and clean only the nested schema values.
    const properties: AnyRecord = {};
    for (const [name, propertyValue] of Object.entries(value.properties)) {
      properties[name] = toGeminiSchemaValue(propertyValue);
    }
    out.properties = properties;
  }
  return out;
}

export function openAiSessionUpdateToGeminiSetup(
  sessionUpdate: AnyRecord,
  geminiModelId: string
): AnyRecord {
  const session = (sessionUpdate?.session ?? {}) as AnyRecord;
  const listeningLanguage = session?.audio?.input?.transcription?.language;
  const openAiTools = Array.isArray(session.tools) ? session.tools : [];
  const functionDeclarations = openAiTools
    .filter((tool) => tool?.type === "function" && typeof tool.name === "string" && tool.name)
    .map((tool) => {
      const declaration: AnyRecord = { name: String(tool.name) };
      if (typeof tool.description === "string" && tool.description) {
        declaration.description = tool.description;
      }
      if (tool.parameters && typeof tool.parameters === "object") {
        declaration.parameters = toGeminiSchemaValue(tool.parameters);
      }
      return declaration;
    });

  const setup: AnyRecord = {
    // BidiGenerateContentSetup.model is required in `models/{model}` form.
    model: `models/${geminiModelId}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
    },
    systemInstruction: {
      parts: [{ text: String(session.instructions ?? "") }],
    },
    inputAudioTranscription:
      listeningLanguage === "ru" || listeningLanguage === "uk" || listeningLanguage === "en"
        ? { languageCodes: [listeningLanguage] }
        : {},
    outputAudioTranscription: {},
  };
  if (functionDeclarations.length) {
    setup.tools = [{ functionDeclarations }];
  }
  // Voice/VAD/OpenAI-only knobs (ttsVoiceId, ttsSpeed, server_vad thresholds)
  // have no direct Live API equivalent. Server defaults already match the
  // accepted behavior: automatic activity detection is on and start of user
  // activity interrupts the model (START_OF_ACTIVITY_INTERRUPTS).
  return { setup };
}

function dataUriToGeminiInlineData(imageUrl: string): AnyRecord | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl.trim());
  if (!match) return null;
  const mimeType = match[1];
  const data = match[2].replace(/\s+/g, "");
  if (!mimeType || !data) return null;
  return { mimeType, data };
}

/**
 * Translate one outgoing OpenAI Realtime client event into zero or more
 * Gemini BidiGenerateContent client messages. Mutates `state` (setup latch,
 * buffered user parts).
 */
export function openAiEventToGeminiMessages(
  event: AnyRecord,
  state: GeminiLiveAdapterState,
  geminiModelId: string
): AnyRecord[] {
  const type = String(event?.type ?? "");

  if (type === "session.update") {
    // Setup is allowed only as the first message of a connection; mid-session
    // preference updates apply from the next session instead.
    if (state.setupSent) return [];
    state.setupSent = true;
    return [openAiSessionUpdateToGeminiSetup(event, geminiModelId)];
  }

  if (type === "input_audio_buffer.append") {
    const data = String(event.audio ?? "");
    if (!data) return [];
    return [{ realtimeInput: { audio: { data, mimeType: GEMINI_LIVE_INPUT_PCM_MIME_TYPE } } }];
  }

  if (type === "response.cancel") {
    // turnComplete=true unconditionally interrupts current generation.
    return [{ clientContent: { turns: [], turnComplete: true } }];
  }

  if (type === "conversation.item.truncate") {
    // The server already truncated its generation on interruption; there is
    // no equivalent client-side truncation message in the Live API.
    return [];
  }

  if (type === "conversation.item.create") {
    const item = (event.item ?? {}) as AnyRecord;
    if (item.type === "function_call_output") {
      const callId = String(item.call_id ?? "");
      if (!callId) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(item.output ?? "{}"));
      } catch {
        parsed = { error: String(item.output ?? "") };
      }
      return [{
        toolResponse: {
          functionResponses: [{
            id: callId,
            name: state.toolNames.get(callId) ?? "",
            response: { result: parsed },
          }],
        },
      }];
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "input_text" && typeof part.text === "string" && part.text) {
        state.pendingUserParts.push({ text: part.text });
      } else if (part?.type === "input_image" && typeof part.image_url === "string") {
        const inlineData = dataUriToGeminiInlineData(part.image_url);
        if (inlineData) state.pendingUserParts.push({ inlineData });
      }
    }
    return [];
  }

  if (type === "response.create") {
    const instructions = event?.response?.instructions;
    const parts = state.pendingUserParts.splice(0);
    if (typeof instructions === "string" && instructions.trim()) {
      parts.push({ text: instructions.trim() });
    }
    if (!parts.length) {
      // Bare response.create (for example right after a tool response):
      // the Live API resumes generation automatically after toolResponse.
      return [];
    }
    return [{ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } }];
  }

  return [];
}

/**
 * Official examples treat each transcription event's text as an incremental
 * segment. If a stream ever sends cumulative text instead, prefer replacing
 * when the new segment already contains everything accumulated so far.
 */
export function appendTranscriptSegment(current: string, segment: string): string {
  if (!segment) return current;
  if (!current) return segment;
  if (segment.startsWith(current)) return segment;
  return current + segment;
}

function flushInputTranscriptInto(events: AnyRecord[], state: GeminiLiveAdapterState): void {
  const transcript = state.inputTranscript.trim();
  if (!transcript) return;
  state.inputTranscript = "";
  state.inputTranscriptItemSeq += 1;
  events.push({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: `gemini-user-${state.inputTranscriptItemSeq}`,
    transcript,
  });
}

function finishTurnInto(events: AnyRecord[], state: GeminiLiveAdapterState, status: string): void {
  flushInputTranscriptInto(events, state);
  if (state.outputTranscript.trim()) {
    events.push({ type: "response.output_audio_transcript.done", transcript: state.outputTranscript.trim() });
  }
  if (state.responding) {
    state.responding = false;
    events.push({ type: "response.output_audio.done" });
    events.push({ type: "response.done", response: { status, output: [] } });
  }
  state.outputTranscript = "";
  state.inputTranscriptClosed = false;
}

/**
 * Translate one incoming Gemini BidiGenerateContentServerMessage into zero or
 * more OpenAI Realtime server events. Mutates `state` (turn latch, transcript
 * accumulators, tool-name map).
 */
export function geminiServerMessageToOpenAiEvents(
  message: AnyRecord,
  state: GeminiLiveAdapterState
): AnyRecord[] {
  const events: AnyRecord[] = [];

  if (message?.setupComplete) {
    // The service treats session.updated as the "start capture / go ready"
    // barrier, mirroring the OpenAI session handshake.
    return [
      { type: "session.created", session: {} },
      { type: "session.updated", session: {} },
    ];
  }

  if (message?.toolCall && Array.isArray(message.toolCall.functionCalls)) {
    flushInputTranscriptInto(events, state);
    for (const functionCall of message.toolCall.functionCalls) {
      const callId = String(functionCall?.id ?? "");
      const name = String(functionCall?.name ?? "");
      if (!callId) continue;
      state.toolNames.set(callId, name);
      const args = functionCall?.args && typeof functionCall.args === "object"
        ? functionCall.args
        : {};
      events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: callId,
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
        },
      });
    }
    return events;
  }

  const serverContent = message?.serverContent;
  if (!serverContent || typeof serverContent !== "object") {
    // usageMetadata / goAway / sessionResumptionUpdate / toolCallCancellation
    // carry no OpenAI-dialect equivalent in v1.
    return events;
  }

  if (serverContent.interrupted === true) {
    flushInputTranscriptInto(events, state);
    events.push({ type: "input_audio_buffer.speech_started" });
    if (state.responding) {
      state.responding = false;
      // An interrupted turn has no generationComplete; the docs sequence is
      // "interrupted > turn_complete". No output_audio.done either: playback
      // was already truncated locally by the barge-in path above.
      events.push({ type: "response.done", response: { status: "incomplete", output: [] } });
    }
    state.outputTranscript = "";
    state.inputTranscriptClosed = false;
    return events;
  }

  const parts = serverContent.modelTurn?.parts;
  if (Array.isArray(parts) && parts.length) {
    flushInputTranscriptInto(events, state);
    if (!state.responding) {
      state.responding = true;
      state.turnCounter += 1;
      events.push({
        type: "response.created",
        response: { id: `gemini-response-${state.turnCounter}`, status: "in_progress", output: [] },
      });
      events.push({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: `gemini-audio-${state.turnCounter}`, type: "message", role: "assistant", content: [] },
      });
      events.push({
        type: "response.content_part.added",
        item_id: `gemini-audio-${state.turnCounter}`,
        output_index: 0,
        content_index: 0,
        part: {},
      });
    }
    for (const part of parts) {
      const inlineData = part?.inlineData;
      if (inlineData && typeof inlineData.data === "string" && inlineData.data) {
        events.push({
          type: "response.output_audio.delta",
          item_id: `gemini-audio-${state.turnCounter}`,
          content_index: 0,
          delta: inlineData.data,
        });
      } else if (typeof part?.text === "string" && part.text) {
        events.push({
          type: "response.output_audio_transcript.delta",
          item_id: `gemini-audio-${state.turnCounter}`,
          content_index: 0,
          delta: part.text,
        });
      }
    }
  }

  const inputTranscription = serverContent.inputTranscription;
  if (
    inputTranscription &&
    typeof inputTranscription === "object" &&
    typeof inputTranscription.text === "string" &&
    inputTranscription.text &&
    !state.inputTranscriptClosed
  ) {
    state.inputTranscript = appendTranscriptSegment(state.inputTranscript, inputTranscription.text);
    if (inputTranscription.finished === true) {
      flushInputTranscriptInto(events, state);
      state.inputTranscriptClosed = true;
    }
  }

  const outputTranscription = serverContent.outputTranscription;
  if (
    outputTranscription &&
    typeof outputTranscription === "object" &&
    typeof outputTranscription.text === "string" &&
    outputTranscription.text
  ) {
    const merged = appendTranscriptSegment(state.outputTranscript, outputTranscription.text);
    const delta = merged.length >= state.outputTranscript.length && merged.startsWith(state.outputTranscript)
      ? merged.slice(state.outputTranscript.length)
      : outputTranscription.text;
    state.outputTranscript = merged;
    if (delta) {
      events.push({ type: "response.output_audio_transcript.delta", delta });
    }
  }

  if (serverContent.generationComplete === true) {
    finishTurnInto(events, state, "completed");
  } else if (serverContent.turnComplete === true) {
    finishTurnInto(events, state, "completed");
  }

  const voiceActivity = message?.voiceActivity;
  if (voiceActivity && typeof voiceActivity === "object") {
    if (voiceActivity.type === "ACTIVITY_START") {
      events.push({ type: "input_audio_buffer.speech_started" });
    } else if (voiceActivity.type === "ACTIVITY_END") {
      events.push({ type: "input_audio_buffer.speech_stopped" });
    }
  }

  return events;
}
