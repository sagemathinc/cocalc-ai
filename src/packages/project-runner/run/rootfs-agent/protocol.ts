/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The wire protocol between project-host and a project's rootfs agent: the
process that does rootfs file operations inside the project's container, as
the project user (see the R1 PR3b design).

The agent is untrusted: the project user controls everything it runs on. So
the host side treats every byte it sends as hostile, and this module is
where that starts:

- a frame is a 4-byte big-endian length, then that many bytes: one type
  byte (JSON or a binary chunk) and the payload; a chunk's payload starts
  with the 4-byte id of the request it belongs to;
- the decoder bounds the frame size and the bytes it buffers, and rejects
  an unknown type, malformed JSON and a partial frame at the end;
- replies must answer a request that is outstanding, exactly once.

Any violation is a ProtocolError; the caller closes the pipe and disposes of
the agent. Nothing in a frame is ever used as a host path.
*/

export const FRAME_JSON = 1;
export const FRAME_CHUNK = 2;

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// at most one maximal frame plus its header may wait for the rest of it
export const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 5;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`rootfs agent protocol: ${message}`);
    this.name = "ProtocolError";
  }
}

export type Frame =
  | { type: typeof FRAME_JSON; value: unknown }
  | { type: typeof FRAME_CHUNK; id: number; data: Buffer };

export function encodeJsonFrame(value: unknown): Buffer {
  return encode(FRAME_JSON, Buffer.from(JSON.stringify(value), "utf8"));
}

export function encodeChunkFrame(id: number, data: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(id, 0);
  return encode(FRAME_CHUNK, Buffer.concat([prefix, data]));
}

function encode(type: number, payload: Buffer): Buffer {
  const length = payload.length + 1;
  if (length > MAX_FRAME_BYTES) {
    throw new ProtocolError(`frame of ${length} bytes is too large`);
  }
  const header = Buffer.alloc(5);
  header.writeUInt32BE(length, 0);
  header.writeUInt8(type, 4);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder for one stream; it fails for good after an error. */
export class FrameDecoder {
  private buffered: Buffer[] = [];
  private size = 0;
  private failed?: ProtocolError;

  constructor(
    private readonly limits = {
      maxFrame: MAX_FRAME_BYTES,
      maxBuffered: MAX_BUFFERED_BYTES,
    },
  ) {}

  /** The complete frames this chunk finishes. */
  push(chunk: Buffer): Frame[] {
    if (this.failed) throw this.failed;
    try {
      this.buffered.push(chunk);
      this.size += chunk.length;
      if (this.size > this.limits.maxBuffered) {
        throw new ProtocolError(
          `more than ${this.limits.maxBuffered} bytes buffered`,
        );
      }
      const frames: Frame[] = [];
      let data = Buffer.concat(this.buffered, this.size);
      while (data.length >= 4) {
        const length = data.readUInt32BE(0);
        if (length < 1 || length > this.limits.maxFrame) {
          throw new ProtocolError(`frame length ${length} is out of bounds`);
        }
        if (data.length < 4 + length) break;
        frames.push(decodeFrame(data.subarray(4, 4 + length)));
        data = data.subarray(4 + length);
      }
      this.buffered = data.length > 0 ? [Buffer.from(data)] : [];
      this.size = data.length;
      return frames;
    } catch (err) {
      this.failed =
        err instanceof ProtocolError ? err : new ProtocolError(`${err}`);
      throw this.failed;
    }
  }

  /** At the end of the stream: anything left over is a partial frame. */
  end(): void {
    if (this.failed) throw this.failed;
    if (this.size > 0) {
      this.failed = new ProtocolError(
        `stream ended inside a frame (${this.size} bytes left)`,
      );
      throw this.failed;
    }
  }
}

function decodeFrame(body: Buffer): Frame {
  const type = body.readUInt8(0);
  const payload = body.subarray(1);
  if (type === FRAME_CHUNK) {
    if (payload.length < 4)
      throw new ProtocolError("chunk without a request id");
    return {
      type,
      id: payload.readUInt32BE(0),
      data: Buffer.from(payload.subarray(4)),
    };
  }
  if (type !== FRAME_JSON) {
    throw new ProtocolError(`unknown frame type ${type}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new ProtocolError("malformed JSON frame");
  }
  return { type, value };
}

/**
 * Matches replies to outstanding requests: a reply must name a request
 * that is outstanding, and each request gets exactly one reply. Anything
 * else (unsolicited, duplicate, a reply without an id) is a violation.
 */
export class ReplyTracker {
  private outstanding = new Set<number>();
  private nextId = 1;

  constructor(private readonly maxOutstanding = 32) {}

  open(): number {
    if (this.outstanding.size >= this.maxOutstanding) {
      throw new ProtocolError(
        `more than ${this.maxOutstanding} requests outstanding`,
      );
    }
    const id = this.nextId++;
    this.outstanding.add(id);
    return id;
  }

  /** The request id a reply answers; it is closed by this. */
  close(reply: unknown): number {
    if (
      reply == null ||
      typeof reply !== "object" ||
      Array.isArray(reply) ||
      !Number.isSafeInteger((reply as { id?: unknown }).id)
    ) {
      throw new ProtocolError("reply without a valid id");
    }
    const id = (reply as { id: number }).id;
    if (!this.outstanding.delete(id)) {
      throw new ProtocolError(
        id > 0 && id < this.nextId
          ? `duplicate reply to request ${id}`
          : `unsolicited reply ${id}`,
      );
    }
    return id;
  }

  /** Requests a timeout gave up on: a late reply to one is unsolicited. */
  abandon(id: number): void {
    this.outstanding.delete(id);
  }

  get size(): number {
    return this.outstanding.size;
  }
}
