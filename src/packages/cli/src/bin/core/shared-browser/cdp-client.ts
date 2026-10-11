/**
 * Minimal Chrome DevTools Protocol client over one browser-level WebSocket,
 * using flat sessions (Target.attachToTarget {flatten: true}).
 */
import WebSocket from "ws";

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export class CdpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private listeners = new Set<(event: CdpEvent) => void>();
  readonly closed: Promise<void>;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const call = this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error) call.reject(new Error(msg.error.message));
        else call.resolve(msg.result ?? {});
      } else if (typeof msg.method === "string") {
        for (const listener of this.listeners) {
          try {
            listener(msg);
          } catch {
            // A failing listener must not break the others.
          }
        }
      }
    });
    this.closed = new Promise((resolve) =>
      ws.once("close", () => {
        for (const call of this.pending.values()) {
          clearTimeout(call.timer);
          call.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        resolve();
      }),
    );
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 0 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new CdpClient(ws);
  }

  send<T = any>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Fire and forget, e.g. acknowledging screencast frames. */
  notify(method: string, params: object = {}, sessionId?: string): void {
    this.ws.send(
      JSON.stringify({ id: this.nextId++, method, params, sessionId }),
    );
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.ws.close();
  }
}
