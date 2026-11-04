import * as SecureStore from "expo-secure-store";

const GEMINI_API_KEY_STORAGE_KEY = "looi.gemini-api-key.v1";
const MIN_GEMINI_API_KEY_LENGTH = 20;

let cachedKey: string | null | undefined;
let loadingKey: Promise<string | null> | null = null;

export class MissingGeminiApiKeyError extends Error {
  constructor() {
    super("Gemini API key is not configured");
    this.name = "MissingGeminiApiKeyError";
  }
}

function normalizeGeminiApiKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key || null;
}

/**
 * Local format check only. The key is verified against the Live API when the
 * first WebSocket session opens; no REST validation call is made from settings.
 */
export function validateGeminiApiKey(value: string): string {
  const key = normalizeGeminiApiKey(value);
  if (!key || key.length < MIN_GEMINI_API_KEY_LENGTH) {
    throw new Error(`Gemini API key must contain at least ${MIN_GEMINI_API_KEY_LENGTH} characters`);
  }
  return key;
}

export async function getGeminiApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  if (!loadingKey) {
    loadingKey = SecureStore.getItemAsync(GEMINI_API_KEY_STORAGE_KEY)
      .then((value) => {
        cachedKey = normalizeGeminiApiKey(value);
        return cachedKey;
      })
      .finally(() => {
        loadingKey = null;
      });
  }
  return loadingKey;
}

export async function hasGeminiApiKey(): Promise<boolean> {
  return Boolean(await getGeminiApiKey());
}

export async function saveGeminiApiKey(value: string): Promise<void> {
  const key = validateGeminiApiKey(value);
  await SecureStore.setItemAsync(GEMINI_API_KEY_STORAGE_KEY, key);
  cachedKey = key;
}

export async function clearGeminiApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(GEMINI_API_KEY_STORAGE_KEY);
  cachedKey = null;
}
