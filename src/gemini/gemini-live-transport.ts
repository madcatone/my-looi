import {
  buildGeminiLiveWebSocketUrl,
  createGeminiLiveAdapterState,
  geminiServerMessageToOpenAiEvents,
  openAiEventToGeminiMessages,
  type GeminiLiveAdapterState,
} from "./gemini-live-protocol";
import { normalizeGeminiLiveModelId } from "./gemini-live-models";

type WebSocketEventHandler = ((event?: unknown) => void) | null;

type TextDecoderLike = { decode(bytes: Uint8Array): string };
type TextDecoderCtor = new (label?: string) => TextDecoderLike;

/**
 * Gemini Live server-to-client messages arrive as binary WebSocket frames
 * carrying JSON text (unlike OpenAI Realtime, which uses text frames).
 * Normalize whatever the platform hands the onmessage handler — string,
 * ArrayBuffer, typed array, or Blob — into a UTF-8 string before parsing.
 *
 * Returns a promise only for Blob payloads (blob.text()); the ArrayBuffer and
 * string paths are synchronous so frame order is preserved on the RN default
 * path.
 */
export function decodeWebSocketFrameData(data: unknown): string | Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decodeArrayBufferToUtf8(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return decodeArrayBufferToUtf8(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  const blob = data as { text?: () => Promise<string> } | null;
  if (blob && typeof blob.text === "function") return blob.text();
  return String(data ?? "");
}

/** UTF-8 decode via the platform TextDecoder when available, else a small decoder. */
export function decodeArrayBufferToUtf8(bytes: Uint8Array): string {
  const decoderCtor = getTextDecoderCtor();
  if (decoderCtor) {
    try {
      return new decoderCtor("utf-8").decode(bytes);
    } catch {
      // Fall through to the manual decoder below.
    }
  }
  return decodeUtf8BytesManually(bytes);
}

function getTextDecoderCtor(): TextDecoderCtor | null {
  const candidate = (globalThis as unknown as { TextDecoder?: TextDecoderCtor }).TextDecoder;
  return typeof candidate === "function" ? candidate : null;
}

/** Minimal UTF-8 decoder for runtimes without TextDecoder. Truncated multibyte sequences degrade permissively. */
function decodeUtf8BytesManually(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      const b1 = i < n ? bytes[i++] : 0;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if (b0 < 0xf0) {
      const b1 = i < n ? bytes[i++] : 0;
      const b2 = i < n ? bytes[i++] : 0;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else {
      const b1 = i < n ? bytes[i++] : 0;
      const b2 = i < n ? bytes[i++] : 0;
      const b3 = i < n ? bytes[i++] : 0;
      const codePoint = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      const offset = codePoint - 0x10000;
      out += offset >= 0
        ? String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
        : String.fromCharCode(codePoint);
    }
  }
  return out;
}

/** Debug summary of an undecodable frame: first 80 bytes as hex + printable latin1. Never contains the API key. */
function summarizeFrameData(data: unknown): string {
  let bytes: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (!bytes) return `${typeof data}`;
  const slice = bytes.slice(0, 80);
  const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  const printable = Array.from(slice, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
  return `${bytes.length} bytes hex[${hex}] text[${printable}]`;
}

/**
 * WebSocket-like transport that speaks the OpenAI Realtime event dialect to
 * RealtimePcmConversationService and the Gemini Live API BidiGenerateContent
 * JSON format on the wire. This is the only stateful piece of the Gemini
 * provider; all message translation lives in gemini-live-protocol.ts.
 *
 * The underlying socket is the React Native global WebSocket. Authentication
 * uses the documented `key` query parameter, so no custom headers are needed.
 */
export class GeminiLiveTransport {
  readyState: number;
  onopen: WebSocketEventHandler = null;
  onmessage: WebSocketEventHandler = null;
  onerror: WebSocketEventHandler = null;
  onclose: WebSocketEventHandler = null;

  private readonly socket: WebSocket;
  private readonly state: GeminiLiveAdapterState;
  private readonly modelId: string;

  constructor(apiKey: string, modelId: string) {
    this.readyState = WebSocket.CONNECTING;
    this.modelId = normalizeGeminiLiveModelId(modelId);
    this.state = createGeminiLiveAdapterState();
    this.socket = new WebSocket(buildGeminiLiveWebSocketUrl(apiKey));
    try {
      // Gemini Live answers with binary frames; without this RN delivers them as Blobs.
      (this.socket as unknown as { binaryType?: string }).binaryType = "arraybuffer";
    } catch {
      // Older RN builds reject binaryType; decodeWebSocketFrameData still handles Blob payloads.
    }

    this.socket.onopen = (event) => {
      console.log("[GeminiLive] WebSocket open");
      this.readyState = WebSocket.OPEN;
      this.onopen?.(event);
    };
    this.socket.onmessage = (message) => {
      this.deliverWireMessage((message as { data?: unknown }).data);
    };
    this.socket.onerror = (event) => {
      console.warn("[GeminiLive] WebSocket error");
      this.onerror?.(event);
    };
    this.socket.onclose = (event) => {
      const close = event as { code?: number; reason?: string } | undefined;
      console.warn(`[GeminiLive] WebSocket closed code=${close?.code ?? "unknown"} reason=${close?.reason ?? ""}`);
      this.readyState = WebSocket.CLOSED;
      this.onclose?.(event);
    };
  }

  /** Receives serialized OpenAI-dialect events; sends translated wire messages. */
  send(data: string): void {
    let event: Record<string, any>;
    try {
      event = JSON.parse(data) as Record<string, any>;
    } catch {
      return;
    }
    const messages = openAiEventToGeminiMessages(event, this.state, this.modelId);
    for (const wireMessage of messages) {
      this.socket.send(JSON.stringify(wireMessage));
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSING;
    try {
      this.socket.close();
    } catch {
      this.readyState = WebSocket.CLOSED;
    }
  }

  private deliverWireMessage(data: unknown): void {
    let decoded: string | Promise<string>;
    try {
      decoded = decodeWebSocketFrameData(data);
    } catch (error) {
      console.warn(
        `[GeminiLive] Failed to decode WebSocket frame: ${summarizeFrameData(data)}`,
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    if (typeof decoded === "string") {
      this.handleWireMessage(decoded);
      return;
    }
    decoded
      .then((text) => this.handleWireMessage(text))
      .catch((error) => {
        console.warn(
          `[GeminiLive] Failed to decode WebSocket frame: ${summarizeFrameData(data)}`,
          error instanceof Error ? error.message : String(error)
        );
      });
  }

  private handleWireMessage(data: string): void {
    let wireMessage: Record<string, any>;
    try {
      wireMessage = JSON.parse(data) as Record<string, any>;
    } catch {
      console.warn(`[GeminiLive] Non-JSON WebSocket message (${data.length} chars): ${data.slice(0, 120)}`);
      return;
    }
    const events = geminiServerMessageToOpenAiEvents(wireMessage, this.state);
    for (const event of events) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
}

export function createGeminiLiveTransport(apiKey: string, modelId: string): WebSocket {
  return new GeminiLiveTransport(apiKey, modelId) as unknown as WebSocket;
}
