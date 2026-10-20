/**
 * WebSocket transport, abstracted so the connection loop can be driven by a
 * scripted fake in tests. One text frame in, one text frame out: the protocol
 * does the rest.
 */

export type TransportErrorKind = "closed" | "failed" | "notOpen";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly code: number;
  readonly reason: string;

  constructor(kind: TransportErrorKind, code = 0, reason = "") {
    super(TransportError.describe(kind, code, reason));
    this.name = "TransportError";
    this.kind = kind;
    this.code = code;
    this.reason = reason;
  }

  static closed(code: number, reason = ""): TransportError {
    return new TransportError("closed", code, reason);
  }

  static failed(detail: string): TransportError {
    return new TransportError("failed", 0, detail);
  }

  static notOpen(): TransportError {
    return new TransportError("notOpen");
  }

  private static describe(kind: TransportErrorKind, code: number, reason: string): string {
    switch (kind) {
      case "closed":
        return reason.length > 0 ? `connection closed (${code}): ${reason}` : `connection closed (${code})`;
      case "failed":
        return reason;
      case "notOpen":
        return "connection is not open";
    }
  }
}

export interface FrameTransport {
  open(url: string): Promise<void>;
  send(text: string): Promise<void>;
  /** Next text frame. Rejects when the socket closes or fails. */
  receive(): Promise<string>;
  close(): Promise<void>;
}

type Delivery = { kind: "text"; text: string } | { kind: "error"; error: TransportError };

/**
 * The real transport: one browser WebSocket. Records the close frame so
 * `receive()` can report the server's code (4001 hello timeout, 4002 version
 * mismatch, 4003 unauthorized).
 */
export class WebSocketTransport implements FrameTransport {
  private socket: WebSocket | null = null;
  private queue: Delivery[] = [];
  private waiter: ((delivery: Delivery) => void) | null = null;
  private closeInfo: { code: number; reason: string } | null = null;
  private ended = false;
  private opened = false;

  constructor(private readonly requestTimeoutMs = 10_000) {}

  async open(url: string): Promise<void> {
    this.ended = false;
    this.opened = false;
    this.closeInfo = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // already gone
        }
        reject(TransportError.failed(`timed out opening ${url}`));
      }, this.requestTimeoutMs);

      const socket = new WebSocket(url);
      this.socket = socket;
      this.bind(socket);

      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opened = true;
        resolve();
      });

      socket.addEventListener("error", () => {
        // Browsers follow `error` with `close`; the close handler reports the
        // server's code, which is what the handshake classifier needs.
      });

      socket.addEventListener("close", (event) => {
        this.closeInfo = { code: event.code, reason: event.reason };
        this.ended = true;
        this.opened = false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(TransportError.closed(event.code, event.reason));
          return;
        }
        const error = TransportError.closed(event.code, event.reason);
        this.deliver({ kind: "error", error });
      });
    });
  }

  private bind(socket: WebSocket): void {
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      if (typeof data === "string") {
        this.deliver({ kind: "text", text: data });
        return;
      }
      if (data instanceof Blob) {
        void data.text().then((text) => this.deliver({ kind: "text", text }));
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.deliver({ kind: "text", text: new TextDecoder().decode(data) });
        return;
      }
      this.deliver({ kind: "error", error: TransportError.failed("unsupported websocket payload") });
    });
  }

  private deliver(delivery: Delivery): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(delivery);
      return;
    }
    this.queue.push(delivery);
  }

  async send(text: string): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.opened || socket.readyState !== WebSocket.OPEN) throw TransportError.notOpen();
    socket.send(text);
  }

  async receive(): Promise<string> {
    const next = this.queue.shift();
    if (next) {
      if (next.kind === "text") return next.text;
      throw next.error;
    }
    if (this.ended) {
      throw TransportError.closed(this.closeInfo?.code ?? 1006, this.closeInfo?.reason ?? "");
    }
    return new Promise<string>((resolve, reject) => {
      this.waiter = (delivery) => {
        if (delivery.kind === "text") resolve(delivery.text);
        else reject(delivery.error);
      };
    });
  }

  async close(): Promise<void> {
    this.opened = false;
    this.ended = true;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "client closed");
      }
    } catch {
      // already gone
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ kind: "error", error: TransportError.closed(1000, "client closed") });
    }
  }
}
