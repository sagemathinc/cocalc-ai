/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The part of ZeroMQ a Jupyter client needs, in plain Node: ZMTP 3.1
(https://rfc.zeromq.org/spec/37/) over TCP (or a Unix socket) with the NULL
mechanism, and the CONNECTING side of DEALER (shell, stdin, control) and SUB
(iopub) sockets.  No native ZeroMQ library.  The peers are libzmq-based
kernels (ipykernel, IRkernel, xeus-*, IJulia, ...).

The semantics cocalc relies on follow libzmq's defaults:
- connect() returns at once; a connection is retried every RECONNECT_IVL ms
  until close(), and a handshake that doesn't finish within HANDSHAKE_IVL ms
  is abandoned and retried;
- messages sent before a connection is ready are queued and sent, in order,
  once it is; a message already written to a connection that then drops is
  never replayed;
- a SUB socket resends its subscriptions on every connection.

Inbound messages go to a lossless queue read by the async iterator.  When
the queue reaches the flow-control mark (MARK_COUNT messages or MARK_BYTES
bytes) the parser stops at that message's boundary and the TCP socket is
paused: TCP pushes back on the kernel, nothing is dropped or refused.

A frame is a flags byte (bit 0 MORE, bit 1 LONG, bit 2 COMMAND), its size (1
byte, or 8 bytes big-endian), then its body.  A connection starts with a
64-byte greeting from each side, then a READY command each way.
*/

import * as net from "node:net";
import { constants as bufferConstants } from "node:buffer";

export const HANDSHAKE_IVL = 30_000; // libzmq's ZMQ_HANDSHAKE_IVL default
export const RECONNECT_IVL = 100; // libzmq's ZMQ_RECONNECT_IVL default
export const MARK_COUNT = 1000; // libzmq's ZMQ_RCVHWM default
export const MARK_BYTES = 64 * 1024 * 1024;
// compaction: once a consumed prefix is past this and past half of an array
const COMPACT_AT = 1024;

export type Frame = Buffer | string;
export type Log = (...args: any[]) => void;

export class ProtocolError extends Error {}

const MAX_FRAME = Math.min(Number.MAX_SAFE_INTEGER, bufferConstants.MAX_LENGTH);

// an exact, unpooled copy: Buffer.from and Buffer.allocUnsafe put small
// buffers in Node's shared pool, whose whole backing store a copy would retain
function exactCopy(src: Buffer, n = src.length): Buffer {
  const dst = Buffer.allocUnsafeSlow(n);
  src.copy(dst, 0, 0, Math.min(n, src.length));
  return dst;
}

function frameHeader(size: number, more: boolean, command: boolean): Buffer {
  const flags = (more ? 1 : 0) | (command ? 4 : 0);
  if (size < 256) {
    return Buffer.from([flags, size]);
  }
  const h = Buffer.alloc(9);
  h[0] = flags | 2;
  h.writeBigUInt64BE(BigInt(size), 1);
  return h;
}

/** The frames of one message, or one command, encoded (header, body, ...). */
export function encodeFrames(frames: Frame[], command = false): Buffer[] {
  const out: Buffer[] = [];
  frames.forEach((f, i) => {
    const body = typeof f === "string" ? Buffer.from(f, "utf8") : f;
    out.push(frameHeader(body.length, i < frames.length - 1, command), body);
  });
  return out;
}

export function greeting(): Buffer {
  const g = Buffer.alloc(64);
  g[0] = 0xff;
  g[9] = 0x7f;
  g[10] = 3; // version 3.1
  g[11] = 1;
  g.write("NULL", 12, "ascii");
  g[32] = 0; // as-server: unused by NULL
  return g;
}

export function command(
  name: string,
  data: Buffer = Buffer.alloc(0),
): Buffer[] {
  const n = Buffer.from(name, "ascii");
  return encodeFrames(
    [Buffer.concat([Buffer.from([n.length]), n, data])],
    true,
  );
}

export function readyCommand(props: Record<string, Buffer>): Buffer[] {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(props)) {
    const n = Buffer.from(name, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(value.length);
    parts.push(Buffer.from([n.length]), n, len, value);
  }
  return command("READY", Buffer.concat(parts));
}

/** READY's (and ERROR's) metadata, bounds-checked. */
export function parseProps(body: Buffer, at: number): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  while (at < body.length) {
    const nl = body[at++];
    if (at + nl + 4 > body.length)
      throw new ProtocolError(
        "malformed metadata: a property name runs past the command",
      );
    const name = body.toString("ascii", at, at + nl);
    at += nl;
    const vl = body.readUInt32BE(at);
    at += 4;
    if (at + vl > body.length)
      throw new ProtocolError(
        "malformed metadata: a property value runs past the command",
      );
    m.set(name.toLowerCase(), body.subarray(at, at + vl));
    at += vl;
  }
  return m;
}

export interface DecoderEvents {
  greeting(g: Buffer): void;
  command(name: string, data: Buffer): void;
  message(frames: Buffer[], bytes: number): void;
}

/**
 * The incremental ZMTP decoder of one connection: chunks in, a greeting, then
 * commands and messages out.  Linear time: a chunk list with a head index
 * and offset; each header parsed once; a body within one chunk is a subarray
 * (copied exactly when it would pin a much larger backing store), a body
 * spanning chunks is copied once.  It stops at a message boundary while
 * `stopped()` says so (the socket's flow control), keeping unparsed bytes.
 */
export class Decoder {
  private chunks: (Buffer | undefined)[] = [];
  private head = 0;
  private off = 0;
  private avail = 0; // unparsed bytes
  private greeted = false;
  // the message in progress
  private frames: Buffer[] = [];
  private framesBytes = 0;
  // a frame body spanning chunks, being filled
  private body?: Buffer;
  private bodyFill = 0;
  private bodyFlags = 0;
  private parsing = false;
  readonly stats = { maxBuffered: 0 };

  constructor(
    private on: DecoderEvents,
    private stopped: () => boolean = () => false,
  ) {}

  /** P + C: the message in progress and the unparsed bytes (logical). */
  buffered(): number {
    return this.framesBytes + (this.body ? this.body.length : 0) + this.avail;
  }

  /** The distinct backing stores this decoder references. */
  backings(into: Set<ArrayBufferLike>): void {
    for (let i = this.head; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c) into.add(c.buffer);
    }
    for (const f of this.frames) into.add(f.buffer);
    if (this.body) into.add(this.body.buffer);
  }

  /** (tests) the array slots still referencing a chunk */
  liveSlots(): number {
    let n = 0;
    for (const c of this.chunks) if (c) n++;
    return n;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.avail += chunk.length;
    this.parse();
  }

  /** Release everything (the connection ended). */
  clear(): void {
    this.chunks = [];
    this.head = this.off = this.avail = 0;
    this.frames = [];
    this.framesBytes = 0;
    this.body = undefined;
  }

  private note(): void {
    const b = this.buffered();
    if (b > this.stats.maxBuffered) this.stats.maxBuffered = b;
  }

  // the byte i positions past the cursor (i < avail)
  private peek(i: number): number {
    let h = this.head;
    let o = this.off + i;
    for (;;) {
      const c = this.chunks[h]!;
      if (o < c.length) return c[o];
      o -= c.length;
      h++;
    }
  }

  private consume(n: number): void {
    this.avail -= n;
    while (n > 0) {
      const c = this.chunks[this.head]!;
      const left = c.length - this.off;
      if (n < left) {
        this.off += n;
        return;
      }
      n -= left;
      this.chunks[this.head++] = undefined;
      this.off = 0;
    }
    if (this.head > COMPACT_AT && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  // n bytes at the cursor as one buffer, consumed (n <= avail)
  private take(n: number): Buffer {
    // (an empty frame may end exactly at a chunk's end, with no chunk at the cursor)
    if (n === 0) return Buffer.allocUnsafeSlow(0);
    const c = this.chunks[this.head]!;
    if (c.length - this.off >= n) {
      let b = c.subarray(this.off, this.off + n);
      // a small body doesn't keep a large backing store alive
      if (b.length * 2 < b.buffer.byteLength) b = exactCopy(b);
      this.consume(n);
      return b;
    }
    const out = this.allocBody(n);
    this.fill(out, 0, n);
    return out;
  }

  // copy n bytes at the cursor into dst at `at`, consumed
  private fill(dst: Buffer, at: number, n: number): void {
    let left = n;
    while (left > 0) {
      const c = this.chunks[this.head]!;
      const k = Math.min(left, c.length - this.off);
      c.copy(dst, at, this.off, this.off + k);
      at += k;
      left -= k;
      this.consume(k);
    }
  }

  private allocBody(n: number): Buffer {
    try {
      return Buffer.allocUnsafeSlow(n);
    } catch (err) {
      throw new ProtocolError(
        `a frame of ${n} bytes can't be allocated: ${err}`,
      );
    }
  }

  /** Parse what is there; throws ProtocolError on a malformed stream. */
  parse(): void {
    if (this.parsing) return;
    this.parsing = true;
    try {
      this.parseLoop();
    } finally {
      this.parsing = false;
      this.note();
    }
  }

  private parseLoop(): void {
    if (!this.greeted) {
      // impossible greetings are rejected as soon as the deciding byte is in
      if (this.avail >= 1 && this.peek(0) !== 0xff)
        throw new ProtocolError("not a ZMTP peer (bad signature)");
      if (this.avail >= 10 && this.peek(9) !== 0x7f)
        throw new ProtocolError("not a ZMTP peer (bad signature)");
      if (this.avail >= 11 && this.peek(10) < 3)
        throw new ProtocolError(
          `the peer speaks ZMTP ${this.peek(10)}.x (libzmq older than 4.0)`,
        );
      if (this.avail < 64) return;
      const g = this.take(64);
      const mech = g.toString("ascii", 12, 32).replace(/\0+$/, "");
      if (mech !== "NULL")
        throw new ProtocolError(
          `the peer's security mechanism is ${mech}, not NULL`,
        );
      this.greeted = true;
      this.on.greeting(g);
    }
    for (;;) {
      if (this.body) {
        const k = Math.min(this.avail, this.body.length - this.bodyFill);
        this.fill(this.body, this.bodyFill, k);
        this.bodyFill += k;
        if (this.bodyFill < this.body.length) return;
        const b = this.body;
        this.body = undefined;
        this.frame(this.bodyFlags, b);
        continue;
      }
      if (this.frames.length === 0 && this.stopped()) return; // at a message boundary
      if (this.avail < 2) return;
      const flags = this.peek(0);
      if (flags & 0xf8)
        throw new ProtocolError(
          `reserved frame flags set (0x${flags.toString(16)})`,
        );
      let size: number;
      let hl: number;
      if (flags & 2) {
        if (this.avail < 9) return;
        let big = 0n;
        for (let i = 1; i < 9; i++) big = (big << 8n) | BigInt(this.peek(i));
        if (big > BigInt(MAX_FRAME))
          throw new ProtocolError(
            `a frame of ${big} bytes exceeds this Node's Buffer limit`,
          );
        size = Number(big);
        hl = 9;
      } else {
        size = this.peek(1);
        hl = 2;
      }
      if (this.avail >= hl + size) {
        this.consume(hl);
        this.frame(flags, this.take(size));
        continue;
      }
      // a body spanning chunks: allocated once, filled as chunks arrive
      this.consume(hl);
      this.body = this.allocBody(size);
      this.bodyFill = 0;
      this.bodyFlags = flags;
    }
  }

  private frame(flags: number, body: Buffer): void {
    if (flags & 4) {
      if (body.length < 1 || 1 + body[0] > body.length)
        throw new ProtocolError(
          "malformed command: its name runs past the frame",
        );
      const name = body.toString("ascii", 1, 1 + body[0]);
      // (a command may arrive between a message's frames: handled, the message keeps accumulating)
      this.on.command(name, body.subarray(1 + body[0]));
      return;
    }
    this.frames.push(body);
    this.framesBytes += body.length;
    if (!(flags & 1)) {
      const msg = this.frames;
      const bytes = this.framesBytes;
      this.frames = [];
      this.framesBytes = 0;
      this.on.message(msg, bytes);
    }
  }
}

type SocketType = "DEALER" | "SUB";
const PEER_TYPES: Record<SocketType, string[]> = {
  DEALER: ["ROUTER"],
  SUB: ["PUB", "XPUB"],
};

class Connection {
  socket: net.Socket;
  decoder: Decoder;
  ready = false;
  timer?: ReturnType<typeof setTimeout>;
  constructor(socket: net.Socket, decoder: Decoder) {
    this.socket = socket;
    this.decoder = decoder;
  }
}

export interface SocketOptions {
  routingId?: string;
  handshakeIvl?: number;
  reconnectIvl?: number;
  markCount?: number;
  markBytes?: number;
  log?: Log;
}

/** The connecting side of a ZMTP socket: DEALER or SUB. */
class ZSocket {
  linger = 0; // (always 0: close discards whatever is pending)
  private _closed = false;
  private gen = 0;
  private conn?: Connection;
  private url?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  // outbound messages not yet written to any connection
  private out: Buffer[][] = [];
  private outBytes = 0;
  // inbound complete messages, for the iterator
  private inq: (Buffer[] | undefined)[] = [];
  private inHead = 0;
  private inBytes: number[] = [];
  private qBytes = 0;
  private qCount = 0;
  private waiting?: (r: IteratorResult<Buffer[]>) => void;
  private stoppedAtMark = false;
  private subs: Buffer[] = [];
  private readonly opts: Required<Omit<SocketOptions, "routingId" | "log">> & {
    routingId?: string;
  };
  private readonly log: Log;
  /** (tests) connection attempts, and those made after close */
  readonly counters = { attempts: 0, attemptsAfterClose: 0 };

  constructor(
    private type: SocketType,
    options: SocketOptions = {},
  ) {
    this.opts = {
      handshakeIvl: options.handshakeIvl ?? HANDSHAKE_IVL,
      reconnectIvl: options.reconnectIvl ?? RECONNECT_IVL,
      markCount: options.markCount ?? MARK_COUNT,
      markBytes: options.markBytes ?? MARK_BYTES,
      routingId: options.routingId,
    };
    this.log = options.log ?? (() => {});
    if (options.routingId != null) {
      const id = Buffer.from(options.routingId);
      if (id.length === 0 || id.length > 255 || id[0] === 0)
        throw new Error(
          "a routing id is 1 to 255 bytes and doesn't start with a zero byte",
        );
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  get handshakeIvl(): number {
    return this.opts.handshakeIvl;
  }

  connect(url: string): void {
    if (this._closed) throw new Error("socket is closed");
    if (this.url != null)
      throw new Error("this socket connects to one endpoint");
    endpoint(url); // (validated now: a bad URL fails the caller)
    this.url = url;
    this.attempt();
  }

  disconnect(_url?: string): void {
    this.close();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.endConnection();
    this.out = [];
    this.outBytes = 0;
    this.inq = [];
    this.inBytes = [];
    this.inHead = this.qBytes = this.qCount = 0;
    this.subs = [];
    const w = this.waiting;
    this.waiting = undefined;
    w?.({ done: true, value: undefined });
  }

  send(frames: Frame[]): void {
    if (this._closed) throw new Error("socket is closed");
    if (this.type === "SUB")
      throw new Error("a SUB socket doesn't send messages");
    const encoded = encodeFrames(frames);
    if (this.conn?.ready && this.out.length === 0) {
      this.write(this.conn, encoded);
      return;
    }
    this.out.push(encoded);
    for (const b of encoded) this.outBytes += b.length;
  }

  subscribe(prefix: string | Buffer = ""): void {
    if (this.type !== "SUB") throw new Error("only a SUB socket subscribes");
    const p = typeof prefix === "string" ? Buffer.from(prefix, "utf8") : prefix;
    const msg = Buffer.concat([Buffer.from([1]), p]);
    this.subs.push(msg);
    if (this.conn?.ready) this.write(this.conn, encodeFrames([msg]));
  }

  /** Diagnostics and tests: what this socket holds. */
  get stats() {
    const backing = new Set<ArrayBufferLike>();
    for (let i = this.inHead; i < this.inq.length; i++)
      for (const f of this.inq[i] ?? []) backing.add(f.buffer);
    this.conn?.decoder.backings(backing);
    let retainedBacking = 0;
    for (const b of backing) retainedBacking += b.byteLength;
    return {
      queuedBytes: this.qBytes,
      queuedCount: this.qCount,
      parserBuffered: this.conn ? this.conn.decoder.buffered() : 0,
      retainedBacking,
      outQueuedBytes: this.outBytes,
      writableLength: this.conn?.socket.writableLength ?? 0,
      paused: this.stoppedAtMark,
      liveSlots:
        this.inq.reduce((n, m) => n + (m ? 1 : 0), 0) +
        (this.conn?.decoder.liveSlots() ?? 0),
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer[]> {
    // As zeromq.js's: leaving a for-await loop (break, or a throw in its
    // body) ends that loop only; the socket stays open, and close() is the
    // caller's.
    let finished = false;
    return {
      next: () =>
        finished
          ? Promise.resolve({ done: true, value: undefined })
          : this.next(),
      return: async () => {
        finished = true;
        const w = this.waiting;
        this.waiting = undefined;
        w?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
  }

  private next(): Promise<IteratorResult<Buffer[]>> {
    if (this.inHead < this.inq.length)
      return Promise.resolve({ done: false, value: this.dequeue() });
    if (this._closed) return Promise.resolve({ done: true, value: undefined });
    if (this.waiting)
      return Promise.reject(new Error("only one next() may wait at a time"));
    return new Promise((resolve) => (this.waiting = resolve));
  }

  private dequeue(): Buffer[] {
    const m = this.inq[this.inHead]!;
    this.inq[this.inHead] = undefined;
    this.qBytes -= this.inBytes[this.inHead];
    this.inHead++;
    this.qCount--;
    if (this.inHead > COMPACT_AT && this.inHead * 2 > this.inq.length) {
      this.inq = this.inq.slice(this.inHead);
      this.inBytes = this.inBytes.slice(this.inHead);
      this.inHead = 0;
    }
    if (
      this.stoppedAtMark &&
      this.qCount * 2 <= this.opts.markCount &&
      this.qBytes * 2 <= this.opts.markBytes
    ) {
      // below half of both marks: parse what is retained, then read again
      setImmediate(() => this.resumeParsing());
    }
    return m;
  }

  private resumeParsing(): void {
    if (this._closed || !this.stoppedAtMark || this.atMark()) return;
    this.stoppedAtMark = false;
    const c = this.conn;
    if (!c) return;
    this.guard(c, () => c.decoder.parse());
    if (!this.stoppedAtMark && this.conn === c) c.socket.resume();
  }

  private atMark(): boolean {
    return (
      this.qCount >= this.opts.markCount || this.qBytes >= this.opts.markBytes
    );
  }

  private enqueue(frames: Buffer[], bytes: number): void {
    if (this.waiting && this.inHead === this.inq.length) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ done: false, value: frames });
      return;
    }
    this.inq.push(frames);
    this.inBytes.push(bytes);
    this.qBytes += bytes;
    this.qCount++;
    if (this.atMark() && !this.stoppedAtMark) {
      this.stoppedAtMark = true;
      this.conn?.socket.pause();
    }
  }

  private attempt(): void {
    this.reconnectTimer = undefined;
    if (this._closed) {
      this.counters.attemptsAfterClose++;
      return;
    }
    this.counters.attempts++;
    const g = ++this.gen;
    const live = () => g === this.gen && !this._closed;
    const ep = endpoint(this.url!);
    const socket = net.connect(ep);
    const decoder = new Decoder(
      {
        greeting: () => {
          if (!live()) return;
          // (the READY each way)
          const props: Record<string, Buffer> = {
            "Socket-Type": Buffer.from(this.type, "ascii"),
          };
          if (this.opts.routingId != null)
            props.Identity = Buffer.from(this.opts.routingId);
          this.write(c, readyCommand(props));
        },
        command: (name, data) => {
          if (!live()) return;
          this.command(c, name, data);
        },
        message: (frames, bytes) => {
          if (!live()) return;
          if (!c.ready) throw new ProtocolError("a message before READY");
          this.enqueue(frames, bytes);
        },
      },
      () => this.stoppedAtMark,
    );
    const c = new Connection(socket, decoder);
    this.conn = c;
    socket.setNoDelay?.(true);
    // (still at the mark from an earlier connection: read nothing until the queue drains)
    if (this.stoppedAtMark) socket.pause();
    socket.on("connect", () => {
      if (!live()) return;
      this.write(c, [greeting()]);
      // the handshake deadline runs from TCP connect until the peer's READY
      c.timer = setTimeout(() => {
        if (!live() || c.ready) return;
        this.fail(c, `no handshake within ${this.opts.handshakeIvl} ms`);
      }, this.opts.handshakeIvl);
    });
    socket.on("data", (d: Buffer) => {
      if (!live()) return;
      this.guard(c, () => c.decoder.push(d));
    });
    socket.on("error", (err) => {
      if (!live()) return;
      this.fail(c, `${err}`, true);
    });
    socket.on("close", () => {
      if (!live()) return;
      this.fail(c, "the connection closed", true);
    });
  }

  private guard(c: Connection, f: () => void): void {
    try {
      f();
    } catch (err) {
      if (this.conn === c)
        this.fail(c, err instanceof ProtocolError ? err.message : `${err}`);
    }
  }

  private command(c: Connection, name: string, data: Buffer): void {
    if (name === "READY") {
      if (c.ready) return;
      const props = parseProps(data, 0);
      const peer = props.get("socket-type")?.toString("ascii") ?? "";
      if (!PEER_TYPES[this.type].includes(peer))
        throw new ProtocolError(
          `a ${this.type} socket can't talk to a ${peer || "untyped"} peer`,
        );
      c.ready = true;
      if (c.timer) clearTimeout(c.timer);
      c.timer = undefined;
      for (const s of this.subs) this.write(c, encodeFrames([s]));
      this.flush(c);
    } else if (name === "ERROR") {
      const n = data.length ? data[0] : 0;
      if (1 + n > data.length)
        throw new ProtocolError("malformed ERROR command");
      throw new ProtocolError(
        `the peer refused the connection: ${data.toString("utf8", 1, 1 + n)}`,
      );
    } else if (name === "PING") {
      if (data.length < 2) throw new ProtocolError("malformed PING command");
      // PONG echoes the context, the bytes after the 2-byte TTL
      this.write(c, command("PONG", data.subarray(2)));
    }
    // PONG, SUBSCRIBE, CANCEL, and unknown commands: nothing to do
  }

  private flush(c: Connection): void {
    const out = this.out;
    this.out = [];
    this.outBytes = 0;
    for (const m of out) this.write(c, m);
  }

  // a message's frames, corked into the socket: never concatenated
  private write(c: Connection, encoded: Buffer[]): void {
    const s = c.socket;
    s.cork();
    for (const b of encoded) s.write(b);
    process.nextTick(() => s.uncork());
  }

  private fail(c: Connection, reason: string, quiet = false): void {
    if (this.conn !== c || this._closed) return;
    if (!quiet || c.ready)
      this.log("zmtp: connection to", this.url, "ended:", reason);
    this.endConnection();
    this.reconnectTimer = setTimeout(
      () => this.attempt(),
      this.opts.reconnectIvl,
    );
  }

  private endConnection(): void {
    const c = this.conn;
    if (!c) return;
    this.conn = undefined;
    this.gen++; // every callback of the old connection is now stale
    if (c.timer) clearTimeout(c.timer);
    c.decoder.clear();
    c.socket.destroy();
  }
}

export class Dealer extends ZSocket {
  constructor(options: SocketOptions = {}) {
    super("DEALER", options);
  }
}

export class Subscriber extends ZSocket {
  constructor(options: SocketOptions = {}) {
    super("SUB", options);
  }
}

/** tcp://host:port, or ipc://path (POSIX only). */
export function endpoint(url: string): net.NetConnectOpts {
  const m = /^(tcp|ipc):\/\/(.+)$/.exec(url);
  if (!m) throw new Error(`not a tcp:// or ipc:// endpoint: ${url}`);
  if (m[1] === "ipc") {
    if (process.platform === "win32")
      throw new Error(
        "ipc:// endpoints aren't supported on Windows; use tcp://",
      );
    return { path: m[2] };
  }
  const i = m[2].lastIndexOf(":");
  const port = Number(m[2].slice(i + 1));
  if (i < 1 || !Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error(`a tcp:// endpoint needs host:port: ${url}`);
  const host = m[2].slice(0, i).replace(/^\[(.*)\]$/, "$1");
  return { host: host === "*" ? "127.0.0.1" : host, port };
}
