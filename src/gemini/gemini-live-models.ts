export const DEFAULT_GEMINI_LIVE_MODEL_ID = "gemini-3.1-flash-live-preview";

export type GeminiLiveModelId = string;

/**
 * Fixed list of Google's current Live API conversation models. The Live API
 * exposes no model-list endpoint; these ids come from the official Live API
 * documentation (aistudio.google.com/docs/live-api) and stay fixed per app
 * release. Output audio for all of them is raw 16-bit PCM at 24 kHz, which
 * matches the existing native playback path (REALTIME_PCM_RATE).
 */
export const GEMINI_LIVE_MODEL_OPTIONS: readonly { id: GeminiLiveModelId; note: "recommended" | "quality" | "previous" }[] = [
  { id: "gemini-3.1-flash-live-preview", note: "recommended" },
  { id: "gemini-3.8-live", note: "quality" },
  { id: "gemini-2.5-flash-native-audio-preview-12-2025", note: "previous" },
];

const SUPPORTED_GEMINI_LIVE_MODEL_IDS = new Set(GEMINI_LIVE_MODEL_OPTIONS.map((option) => option.id));

export function isGeminiLiveModelId(value: string): boolean {
  return SUPPORTED_GEMINI_LIVE_MODEL_IDS.has(value.trim());
}

export function normalizeGeminiLiveModelId(value: unknown): string {
  return typeof value === "string" && isGeminiLiveModelId(value)
    ? value.trim()
    : DEFAULT_GEMINI_LIVE_MODEL_ID;
}

export function formatGeminiLiveModelName(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (normalized === "gemini-3.1-flash-live-preview") return "Gemini 3.1 Flash Live";
  if (normalized === "gemini-3.8-live") return "Gemini 3.8 Live";
  if (normalized === "gemini-2.5-flash-native-audio-preview-12-2025") return "Gemini 2.5 Flash Live (native audio)";
  return id;
}
