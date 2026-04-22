/**
 * PostMessage Bridge — client library for apps to communicate with
 * connector UI components (player, map, gallery) via iframe postMessage.
 *
 * Usage:
 *   const bridge = new ConnectorBridge(iframeRef, 'youeye-player-v1');
 *   bridge.on('state', (data) => setPlaying(data.playing));
 *   bridge.on('ready', () => bridge.send('play', { trackId: '123' }));
 *   bridge.init({ token: accessToken });
 *
 * The bridge validates that messages come from the expected origin
 * (connectors.devvm.test) and match the declared protocol.
 */

export type ProtocolName =
  | "youeye-player-v1"
  | "youeye-map-v1"
  | "youeye-viewer-v1"
  | "youeye-card-v1";

export interface BridgeOptions {
  /** Override the expected origin (default: derived from NEXT_PUBLIC_CONNECTORS_URL) */
  origin?: string;
  /** Timeout in ms for the ready handshake (default: 5000) */
  readyTimeout?: number;
}

type MessageHandler = (data: Record<string, unknown>) => void;

const PROTOCOL_READY_EVENTS: Record<ProtocolName, string> = {
  "youeye-player-v1": "youeye-player-ready",
  "youeye-map-v1": "youeye-map-ready",
  "youeye-viewer-v1": "youeye-viewer-ready",
  "youeye-card-v1": "youeye-card-ready",
};

export class ConnectorBridge {
  private iframe: HTMLIFrameElement;
  private protocol: ProtocolName;
  private origin: string;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private ready = false;
  private readyTimeout: number;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;

  constructor(
    iframe: HTMLIFrameElement,
    protocol: ProtocolName,
    options: BridgeOptions = {}
  ) {
    this.iframe = iframe;
    this.protocol = protocol;
    this.origin = options.origin || this.getDefaultOrigin();
    this.readyTimeout = options.readyTimeout ?? 5000;

    this.listener = this.handleMessage.bind(this);
    window.addEventListener("message", this.listener);
  }

  private getDefaultOrigin(): string {
    if (typeof window !== "undefined") {
      // In browser context, derive from current location or env
      const connectorsUrl =
        (typeof process !== "undefined" &&
          process.env?.NEXT_PUBLIC_CONNECTORS_URL) ||
        "";
      if (connectorsUrl) {
        try {
          return new URL(connectorsUrl).origin;
        } catch {
          /* fall through */
        }
      }
    }
    return "*"; // fallback — less secure but functional
  }

  private handleMessage(e: MessageEvent): void {
    // Validate origin if set
    if (this.origin !== "*" && e.origin !== this.origin) return;

    const data = e.data;
    if (!data || typeof data !== "object") return;

    const readyEvent = PROTOCOL_READY_EVENTS[this.protocol];

    // Handle ready signal
    if (data.type === readyEvent) {
      this.ready = true;
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.emit("ready", data);
      return;
    }

    // Forward all other messages to registered handlers
    if (data.type) {
      this.emit(data.type as string, data);
    }
  }

  /** Register a handler for a message type */
  on(type: string, handler: MessageHandler): this {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }

  /** Remove a handler */
  off(type: string, handler: MessageHandler): this {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== handler)
      );
    }
    return this;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const list = this.handlers.get(type);
    if (list) {
      for (const handler of list) {
        try {
          handler(data);
        } catch {
          /* handler errors shouldn't break the bridge */
        }
      }
    }
  }

  /** Send init message with config/token. Starts the ready handshake. */
  init(config: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.postToIframe({ type: "init", ...config });

      if (this.ready) {
        resolve();
        return;
      }

      // Set up ready timeout
      const onReady = () => {
        resolve();
        this.off("ready", onReady);
      };
      this.on("ready", onReady);

      this.readyTimer = setTimeout(() => {
        if (!this.ready) {
          this.off("ready", onReady);
          reject(new Error(`${this.protocol} ready timeout after ${this.readyTimeout}ms`));
        }
      }, this.readyTimeout);
    });
  }

  /** Send a command to the connector UI component */
  send(action: string, params: Record<string, unknown> = {}): void {
    this.postToIframe({ type: "command", action, ...params });
  }

  /** Check if the bridge has received the ready signal */
  isReady(): boolean {
    return this.ready;
  }

  /** Clean up — remove event listener */
  destroy(): void {
    if (this.listener) {
      window.removeEventListener("message", this.listener);
      this.listener = null;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.handlers.clear();
  }

  private postToIframe(data: Record<string, unknown>): void {
    const win = this.iframe.contentWindow;
    if (win) {
      win.postMessage(data, this.origin);
    }
  }
}

/**
 * Build the iframe URL for a connector UI component.
 *
 * @param connectorId - e.g. "spotify-music"
 * @param entry - e.g. "player.html"
 * @param connectorsBaseUrl - e.g. "https://connectors.devvm.test"
 */
export function connectorUiUrl(
  connectorId: string,
  entry: string,
  connectorsBaseUrl?: string
): string {
  const base =
    connectorsBaseUrl ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_CONNECTORS_URL) ||
    "";
  return `${base}/assets/${connectorId}/${entry}`;
}
