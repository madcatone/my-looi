import {
  buildGeminiLiveWebSocketUrl,
  createGeminiLiveAdapterState,
  geminiServerMessageToOpenAiEvents,
  openAiEventToGeminiMessages,
  type GeminiLiveAdapterState,
} from "./gemini-live-protocol";
import { normalizeGeminiLiveModelId } from "./gemini-live-models";

type WebSocketEventHandler = ((event?: unknown) => void) | null;

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

    this.socket.onopen = (event) => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(event);
    };
    this.socket.onmessage = (message) => {
      this.handleWireMessage(String((message as { data?: unknown }).data ?? ""));
    };
    this.socket.onerror = (event) => {
      this.onerror?.(event);
    };
    this.socket.onclose = (event) => {
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

  private handleWireMessage(data: string): void {
    let wireMessage: Record<string, any>;
    try {
      wireMessage = JSON.parse(data) as Record<string, any>;
    } catch {
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
