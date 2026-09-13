import type { Message, Subscription } from "@cocalc/conat/core/client";
import { abortable } from "../core/abort";

export const READ_PROTOCOL = "ack-v1";
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_READ_WAIT = 60 * 1000;
export const READ_HANDSHAKE_WAIT = 5000;

export function readIdleWait(requested: unknown): number {
  return Number.isSafeInteger(requested) && (requested as number) > 0
    ? Math.min(requested as number, MAX_READ_WAIT)
    : MAX_READ_WAIT;
}

// Acknowledgements represent consumption, not publication to the router.
// There is exactly one outstanding sequence; duplicate ACKs grant no credit.
export class ReadFlow {
  readonly controller = new AbortController();
  private controls?: Subscription;
  private timer: ReturnType<typeof setTimeout>;
  private expected = -1;
  private resolveAck?: () => void;
  private closed = false;

  constructor(private readonly maxWait: number) {
    this.resetTimer(Math.min(maxWait, READ_HANDSHAKE_WAIT));
  }

  private resetTimer(wait: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.controller.abort(Error("file read timed out")),
      wait,
    );
    this.timer.unref?.();
  }

  async start(message: Message) {
    const ready = this.expect(0);
    this.controls = await message.respondMany(null, {
      headers: { fileReadProtocol: READ_PROTOCOL },
      // ReadFlow owns the idle timer: duplicate ACKs must not extend it.
      timeout: Math.min(this.maxWait, READ_HANDSHAKE_WAIT),
      maxQueue: 8,
      maxQueueBytes: 4096,
      signal: this.controller.signal,
    });
    void this.listen();
    await this.wait(ready);
  }

  private async listen() {
    try {
      for await (const message of this.controls!) {
        const value = message.data;
        if (value?.cancel) throw Error("file read cancelled");
        const seq = value?.seq;
        if (!Number.isSafeInteger(seq) || seq > this.expected || seq < 0) {
          throw Error("invalid file read acknowledgement");
        }
        if (seq === this.expected) {
          const resolve = this.resolveAck;
          this.resolveAck = undefined;
          if (resolve) {
            this.progress();
            resolve();
          }
        }
      }
      if (!this.closed) throw Error("file read control channel closed");
    } catch (err) {
      if (!this.closed) this.controller.abort(err);
    }
  }

  expect(seq: number): Promise<void> {
    this.expected = seq;
    return new Promise((resolve) => (this.resolveAck = resolve));
  }

  progress() {
    if (!this.closed && !this.controller.signal.aborted)
      this.resetTimer(this.maxWait);
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    return await abortable(promise, this.controller.signal);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controls?.cancel();
    this.controller.abort(Error("file read closed"));
    this.resolveAck = undefined;
  }
}
