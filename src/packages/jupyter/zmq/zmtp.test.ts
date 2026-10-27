/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The pure-JS ZMTP transport (./zmtp.ts), without a kernel: the codec, a
seeded fuzz, the connection lifecycle, delivery and flow control, and the
mutants that must fail these checks.  The peers here are small fake ZMTP
servers built from the same codec; ./zmtp-interop.test.ts talks to libzmq.
*/

import assert from "node:assert/strict";
import * as net from "node:net";
// (the module object itself: an import namespace's properties are read-only)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawNet = require("node:net");
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Z from "./zmtp";

const FUZZ_CASES = Number(process.env.ZMTP_FUZZ_CASES ?? 5000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

const ready = (type: string, id?: string) => Z.readyCommand({ "Socket-Type": Buffer.from(type), ...(id ? { Identity: Buffer.from(id) } : {}) });
const cat = (bufs: Buffer[]) => Buffer.concat(bufs);

// a recorded session from a ROUTER: greeting, READY, then messages
function session(messages: Buffer[][], type = "ROUTER"): Buffer {
  return cat([Z.greeting(), ...ready(type), ...messages.flatMap((m) => Z.encodeFrames(m))]);
}

// decode a byte stream fed in the given pieces
function decode(stream: Buffer, pieces: number[] | "bytes" = [stream.length]) {
  const got: Buffer[][] = [];
  const cmds: string[] = [];
  let greeted = 0;
  const d = new Z.Decoder({ greeting: () => greeted++, command: (n) => cmds.push(n), message: (f) => got.push(f) });
  const sizes = pieces === "bytes" ? Array(stream.length).fill(1) : pieces;
  let at = 0;
  for (const n of sizes) {
    d.push(stream.subarray(at, at + n));
    at += n;
  }
  if (at < stream.length) d.push(stream.subarray(at));
  return { got, cmds, greeted, d };
}

const same = (a: Buffer[][], b: Buffer[][]) => assert.deepEqual(a.map((m) => m.map((f) => f.toString("hex"))), b.map((m) => m.map((f) => f.toString("hex"))));

// a seeded PRNG (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Peer {
  socket: net.Socket;
  frames: Buffer[][];
  send(frames: (Buffer | string)[]): void;
  raw(b: Buffer): void;
}

// a fake ZMTP server of the given type; behavior "normal" handshakes, others misbehave
async function server(type: "ROUTER" | "PUB" | "XPUB" | "REP", behavior: "normal" | "silent" | "partial" | "no-ready" | "http" = "normal") {
  const peers: Peer[] = [];
  const srv = net.createServer((s) => {
    const p: Peer = {
      socket: s,
      frames: [],
      send: (f) => s.write(cat(Z.encodeFrames(f))),
      raw: (b) => s.write(b),
    };
    peers.push(p);
    s.on("error", () => {});
    if (behavior === "silent") return;
    if (behavior === "http") return void s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    if (behavior === "partial") return void s.write(Z.greeting().subarray(0, 20));
    s.write(Z.greeting());
    if (behavior === "no-ready") return;
    let readied = false;
    const d = new Z.Decoder({
      greeting: () => {
        readied = true;
        s.write(cat(ready(type)));
      },
      command: () => {},
      message: (f) => p.frames.push(f),
    });
    s.on("data", (b) => {
      try {
        d.push(b);
      } catch {
        s.destroy();
      }
    });
    void readied;
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    url: `tcp://127.0.0.1:${port}`,
    peers,
    close: () => new Promise<void>((r) => { for (const p of peers) p.socket.destroy(); srv.close(() => r()); }),
  };
}

async function until(f: () => boolean, ms = 5000, what = "a condition") {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// resources other than the test runner's own: the baseline is taken before a test's sockets
const resources = () => process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap" && r !== "PipeWrap");
async function settledResources(baseline: string[]) {
  const count = (v: string[]) => v.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  for (let i = 0; i < 100; i++) {
    const now = count(resources()), base = count(baseline);
    if ([...now].every(([k, n]) => n <= (base.get(k) ?? 0))) return true;
    await sleep(10);
  }
  return false;
}

// ---------------------------------------------------------------- 1. codec

describe("the codec", () => {
  test("a round trip at 0, 1, 255, 256, 2^16 bytes and 64 MiB", () => {
    for (const n of [0, 1, 255, 256, 1 << 16, 64 << 20]) {
      const m = [Buffer.alloc(n, 7), Buffer.from("tail")];
      const { got } = decode(session([m]));
      assert.equal(got.length, 1);
      assert.equal(got[0][0].length, n);
      assert.ok(got[0][0].equals(m[0]) && got[0][1].equals(m[1]));
    }
  });

  test("the short/LONG size boundary is at 255/256", () => {
    assert.equal(Z.encodeFrames([Buffer.alloc(255)])[0].length, 2);
    assert.equal(Z.encodeFrames([Buffer.alloc(256)])[0].length, 9);
    assert.equal(Z.encodeFrames([Buffer.alloc(256)])[0][0] & 2, 2);
  });

  test("every split point of a recorded session, and byte by byte, decodes the same", () => {
    const msgs = [[Buffer.from("a")], [Buffer.alloc(300, 1), Buffer.from("x")], [Buffer.from("<IDS|MSG>"), Buffer.alloc(70000, 2)]];
    const stream = session(msgs);
    const whole = decode(stream).got;
    same(whole, msgs);
    for (let i = 1; i < stream.length; i += i < 400 ? 1 : 997) same(decode(stream, [i]).got, msgs);
    same(decode(stream, "bytes").got, msgs);
  });

  test("reserved flag bits are a protocol error", () => {
    const s = cat([Z.greeting(), ...ready("ROUTER"), Buffer.from([0x08, 1, 65])]);
    assert.throws(() => decode(s), /reserved frame flags/);
  });

  test("sizes beyond the Buffer limit are protocol errors, and an allocation failure is one too", () => {
    for (const big of [2n ** 53n, BigInt(require("node:buffer").constants.MAX_LENGTH) + 1n, 2n ** 62n]) {
      const h = Buffer.alloc(9);
      h[0] = 2;
      h.writeBigUInt64BE(big, 1);
      assert.throws(() => decode(cat([Z.greeting(), ...ready("ROUTER"), h, Buffer.from("x")])), Z.ProtocolError);
    }
  });

  test("malformed commands and READY metadata are protocol errors", () => {
    const g = Z.greeting();
    assert.throws(() => decode(cat([g, ...Z.encodeFrames([Buffer.from([9, 65])], true)])), /its name runs past/);
    assert.throws(() => Z.parseProps(Buffer.from([20, 65]), 0), /property name runs past/);
    const v = Buffer.concat([Buffer.from([1]), Buffer.from("A"), Buffer.from([0, 0, 0, 9]), Buffer.from("x")]);
    assert.throws(() => Z.parseProps(v, 0), /property value runs past/);
  });

  test("impossible greetings are rejected as soon as their deciding byte arrives", () => {
    assert.throws(() => decode(Buffer.from("H")), /bad signature/);
    const g = Z.greeting();
    const bad9 = Buffer.from(g);
    bad9[9] = 0;
    assert.throws(() => decode(bad9.subarray(0, 10)), /bad signature/);
    const v2 = Buffer.from(g);
    v2[10] = 2;
    assert.throws(() => decode(v2.subarray(0, 11)), /ZMTP 2/);
    const curve = Buffer.from(g);
    curve.write("CURVE", 12, "ascii");
    assert.throws(() => decode(curve), /CURVE, not NULL/);
  });

  test("a command between the frames of a multipart message is handled, and the message completes", () => {
    const s = cat([Z.greeting(), ...ready("ROUTER"), Buffer.from([1, 1, 65]), ...Z.command("PING", Buffer.from([0, 10, 1, 2])), Buffer.from([0, 1, 66])]);
    const { got, cmds } = decode(s);
    assert.deepEqual(cmds, ["READY", "PING"]);
    same(got, [[Buffer.from("A"), Buffer.from("B")]]);
  });

  test("a tiny body never retains a pooled or larger backing store", () => {
    const big = Buffer.allocUnsafeSlow(65536);
    const s = session([[Buffer.from("x")]]);
    s.copy(big);
    const { got } = decode(big.subarray(0, s.length));
    assert.equal(got[0][0].buffer.byteLength, 1);
    // spanning two chunks: an exact, unpooled copy
    const s2 = session([[Buffer.alloc(100, 3)]]);
    const { got: g2 } = decode(s2, [s2.length - 50]);
    assert.equal(g2[0][0].buffer.byteLength, 100);
  });
});

// ---------------------------------------------------------------- 2. fuzz

describe("the fuzz (seeded)", () => {
  test(`${FUZZ_CASES} cases: valid streams split at random decode exactly; mutated streams decode or fail cleanly; the parser's buffer stays bounded`, () => {
    const seed = Number(process.env.ZMTP_FUZZ_SEED ?? 20261027);
    const r = rng(seed);
    for (let k = 0; k < FUZZ_CASES; k++) {
      const t0 = Date.now();
      const msgs: Buffer[][] = [];
      let biggest = 0;
      for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) {
        const m: Buffer[] = [];
        for (let j = 0, nf = 1 + Math.floor(r() * 3); j < nf; j++) {
          const size = r() < 0.1 ? 256 + Math.floor(r() * 3000) : Math.floor(r() * 300);
          const f = Buffer.alloc(size);
          for (let b = 0; b < Math.min(size, 16); b++) f[b] = Math.floor(r() * 256);
          m.push(f);
        }
        biggest = Math.max(biggest, m.reduce((a, f) => a + f.length + 9, 0));
        msgs.push(m);
      }
      const stream = session(msgs);
      const pieces: number[] = [];
      let maxChunk = 0;
      for (let left = stream.length; left > 0; ) {
        const n = Math.min(left, 1 + Math.floor(r() * 500));
        pieces.push(n);
        maxChunk = Math.max(maxChunk, n);
        left -= n;
      }
      const where = `seed ${seed}, case ${k}`;
      const { got, d } = decode(stream, pieces);
      try {
        same(got, msgs);
      } catch (e) {
        throw new Error(`${where}: ${e}`);
      }
      // parser-local: P + C, at most the message in progress plus one chunk (and a header)
      assert.ok(d.stats.maxBuffered <= biggest + maxChunk + 64 + 9, `${where}: parser buffered ${d.stats.maxBuffered}`);
      // mutated: decode or a ProtocolError, nothing else
      const bad = Buffer.from(stream);
      for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) bad[Math.floor(r() * bad.length)] = Math.floor(r() * 256);
      try {
        decode(bad, pieces);
      } catch (e) {
        if (!(e instanceof Z.ProtocolError)) throw new Error(`${where}: a mutated stream threw ${e}`);
      }
      if (Date.now() - t0 > 2000) throw new Error(`${where}: over the 2 s per-case deadline`);
    }
  });
});

// ---------------------------------------------------------------- 3. lifecycle

describe("the connection lifecycle", () => {
  test("the default handshake deadline is libzmq's 30 s", () => {
    const d = new Z.Dealer({ routingId: "x" });
    assert.equal(d.handshakeIvl, 30_000);
    d.close();
  });

  for (const behavior of ["silent", "partial", "no-ready"] as const) {
    test(`a ${behavior} peer is abandoned at the handshake deadline, then retried`, async () => {
      const base = resources();
      const srv = await server("ROUTER", behavior);
      const d = new Z.Dealer({ routingId: "x", handshakeIvl: 200 });
      d.connect(srv.url);
      await until(() => d.counters.attempts >= 2, 3000, "a retry after the deadline");
      d.close();
      await srv.close();
      assert.equal(d.counters.attemptsAfterClose, 0);
      assert.ok(await settledResources(base), JSON.stringify(resources()));
    });
  }

  test("an HTTP listener is rejected at its first byte, long before the deadline", async () => {
    const srv = await server("ROUTER", "http");
    const d = new Z.Dealer({ routingId: "x" });
    d.connect(srv.url);
    await until(() => d.counters.attempts >= 2, 2000, "a retry");
    d.close();
    await srv.close();
  });

  test("close during the handshake, and during the backoff, leaves nothing and never reconnects", async () => {
    const base = resources();
    const srv = await server("ROUTER", "silent");
    const a = new Z.Dealer({ routingId: "x", handshakeIvl: 10_000 });
    a.connect(srv.url);
    await until(() => srv.peers.length >= 1);
    a.close();
    await srv.close();
    const b = new Z.Dealer({ routingId: "y", reconnectIvl: 10_000 });
    b.connect("tcp://127.0.0.1:1"); // refused: in its backoff
    await sleep(100);
    b.close();
    await sleep(50);
    assert.equal(a.counters.attemptsAfterClose + b.counters.attemptsAfterClose, 0);
    assert.ok(await settledResources(base), JSON.stringify(resources()));
  });

  test("a stale callback of an old connection doesn't touch its replacement", async () => {
    const srv = await server("ROUTER");
    const made: net.Socket[] = [];
    const orig = rawNet.connect;
    rawNet.connect = (...a: any[]) => {
      const s = (orig as any)(...a);
      made.push(s);
      return s;
    };
    try {
      const d = new Z.Dealer({ routingId: "x", reconnectIvl: 20 });
      d.connect(srv.url);
      d.send(["one"]);
      await until(() => srv.peers[0]?.frames.length === 1);
      srv.peers[0].socket.destroy(); // the first connection ends
      await until(() => srv.peers.length === 2 && made.length === 2);
      d.send(["two"]);
      await until(() => srv.peers[1].frames.length === 1, 3000, "the second connection");
      // the old connection's late data, error and close
      made[0].emit("data", cat(Z.encodeFrames(["stale"])));
      made[0].emit("error", new Error("late"));
      made[0].emit("close");
      await sleep(50);
      assert.equal(d.stats.queuedCount, 0, "a stale message was delivered");
      d.send(["three"]);
      await until(() => srv.peers[1].frames.length === 2, 3000, "the replacement still used");
      assert.equal(srv.peers.length, 2);
      d.close();
    } finally {
      rawNet.connect = orig;
      await srv.close();
    }
  });

  test("disconnect ends a pending next()", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x" });
    d.connect(srv.url);
    const it = d[Symbol.asyncIterator]();
    const p = it.next();
    d.disconnect(srv.url);
    assert.deepEqual(await p, { done: true, value: undefined });
    await srv.close();
  });
});

// ---------------------------------------------------------------- 4. delivery and flow control

describe("delivery and flow control", () => {
  test("a burst of 1000 messages in one chunk arrives exactly once, in order", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x" });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    srv.peers[0].raw(cat(Array.from({ length: 1000 }, (_, i) => cat(Z.encodeFrames([String(i)])))));
    const seen: number[] = [];
    for await (const m of d) {
      seen.push(Number(m[0].toString()));
      if (seen.length === 1000) break;
    }
    assert.deepEqual(seen, Array.from({ length: 1000 }, (_, i) => i));
    await srv.close();
  });

  test("a delayed consumer: the socket pauses at the mark, nothing is lost, and the queue bound holds", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x", markCount: 10, markBytes: 1 << 30 });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    for (let i = 0; i < 200; i++) srv.peers[0].send([String(i)]);
    await until(() => d.stats.paused, 3000, "the pause");
    assert.ok(d.stats.queuedCount <= 10, `queued ${d.stats.queuedCount}`);
    const it = d[Symbol.asyncIterator]();
    for (let i = 0; i < 200; i++) {
      const r = await it.next();
      assert.equal(r.value![0].toString(), String(i));
      assert.ok(d.stats.queuedCount <= 10);
      if (i % 50 === 0) await sleep(20);
    }
    d.close();
    await srv.close();
  });

  test("a nonempty queue plus a large message completed by a 1-byte chunk: the parser stops right after it", async () => {
    const KiB = 1024;
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x", markCount: 1000, markBytes: 64 * KiB });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    const p = srv.peers[0];
    for (let i = 0; i < 63; i++) p.send([Buffer.alloc(KiB, i)]); // 63 KiB queued
    await until(() => d.stats.queuedCount === 63);
    const big = cat(Z.encodeFrames([Buffer.alloc(64 * KiB, 1), Buffer.alloc(64 * KiB, 2)])); // a 128 KiB message
    p.raw(big.subarray(0, big.length - 1));
    await sleep(100);
    assert.equal(d.stats.queuedCount, 63);
    p.raw(cat([big.subarray(big.length - 1), ...Z.encodeFrames(["after-1"]), ...Z.encodeFrames(["after-2"])]));
    await until(() => d.stats.queuedCount === 64, 3000, "the large message");
    await sleep(100);
    assert.equal(d.stats.queuedCount, 64, "nothing completes after the crossing message");
    assert.equal(d.stats.queuedBytes, 63 * KiB + 128 * KiB);
    assert.ok(d.stats.paused);
    assert.ok(d.stats.parserBuffered > 0, "the later messages stay unparsed");
    const it = d[Symbol.asyncIterator]();
    for (let i = 0; i < 63; i++) assert.equal((await it.next()).value![0][0], i);
    const m = (await it.next()).value!;
    assert.equal(m.length, 2);
    assert.equal(m[1][0], 2);
    assert.equal((await it.next()).value![0].toString(), "after-1");
    assert.equal((await it.next()).value![0].toString(), "after-2");
    d.close();
    await srv.close();
  });

  test("drain/repeat: consumed slots are released, and retained backing returns to 0", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x", markCount: 8, markBytes: 1 << 30 });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    const it = d[Symbol.asyncIterator]();
    for (let cycle = 0; cycle < 50; cycle++) {
      for (let i = 0; i < 8; i++) srv.peers[0].send([Buffer.alloc(1 << 20, i)]);
      for (let i = 0; i < 8; i++) assert.equal((await it.next()).value![0][0], i);
      await until(() => d.stats.retainedBacking === 0 && d.stats.liveSlots === 0, 3000, `released after cycle ${cycle}: ${JSON.stringify(d.stats)}`);
    }
    d.close();
    await srv.close();
  });

  test("close with a pending next(): done, and everything released", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x" });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    srv.peers[0].send(["queued"]);
    await until(() => d.stats.queuedCount === 1);
    const it = d[Symbol.asyncIterator]();
    await it.next();
    const p = it.next();
    d.close();
    assert.deepEqual(await p, { done: true, value: undefined });
    assert.equal(d.stats.retainedBacking, 0);
    await srv.close();
  });

  test("queued messages survive a lost connection; submitted ones are never replayed", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x", reconnectIvl: 300 });
    d.connect(srv.url);
    d.send(["before-connect"]); // queued, then sent at READY
    await until(() => srv.peers[0]?.frames.length === 1);
    srv.peers[0].socket.destroy();
    await sleep(50);
    d.send(["while-down"]); // queued: no connection is ready
    await until(() => srv.peers[1]?.frames.length === 1, 3000, "the reconnect");
    await sleep(100);
    const all = srv.peers.flatMap((p) => p.frames.map((f) => f[0].toString()));
    assert.deepEqual(all, ["before-connect", "while-down"]);
    d.close();
    await srv.close();
  });

  test("a SUB resends its subscription on every connection", async () => {
    const srv = await server("XPUB");
    const s = new Z.Subscriber({ reconnectIvl: 20 });
    s.connect(srv.url);
    s.subscribe();
    await until(() => srv.peers[0]?.frames.length === 1);
    assert.equal(srv.peers[0].frames[0][0].toString("hex"), "01");
    srv.peers[0].socket.destroy();
    await until(() => srv.peers[1]?.frames.length === 1, 3000, "the subscription on the new connection");
    assert.equal(srv.peers[1].frames[0][0].toString("hex"), "01");
    s.close();
    await srv.close();
  });

  test("PING is answered with PONG echoing the context after the TTL", async () => {
    const srv = await server("ROUTER");
    const d = new Z.Dealer({ routingId: "x" });
    d.connect(srv.url);
    d.send(["hi"]);
    await until(() => srv.peers[0]?.frames.length === 1);
    const pongs: Buffer[] = [];
    const dec = new Z.Decoder({ greeting: () => {}, command: (n, data) => n === "PONG" && pongs.push(Buffer.from(data)), message: () => {} });
    dec.push(Z.greeting());
    srv.peers[0].socket.on("data", (b) => dec.push(b));
    srv.peers[0].raw(cat(Z.command("PING", Buffer.from([0, 50, 0xca, 0xfe]))));
    await until(() => pongs.length === 1);
    assert.equal(pongs[0].toString("hex"), "cafe");
    d.close();
    await srv.close();
  });

  test("an incompatible peer type is refused", async () => {
    const srv = await server("REP");
    const d = new Z.Dealer({ routingId: "x", reconnectIvl: 20 });
    d.connect(srv.url);
    d.send(["never"]);
    await until(() => d.counters.attempts >= 3, 3000, "retries");
    assert.ok(srv.peers.every((p) => p.frames.length === 0));
    d.close();
    await srv.close();
  });
});

// ---------------------------------------------------------------- 7. mutants

// Each mutant is one textual replacement in zmtp.ts, compiled and loaded from
// a temp file, and must fail its named check.  No switch in production code.
const MUTANTS: [string, string, string, (Zm: typeof Z) => Promise<void> | void][] = [
  ["m1: the short/LONG boundary at 254", "if (size < 256) {", "if (size < 255) {", (Zm) => {
    assert.equal(Zm.encodeFrames([Buffer.alloc(255)])[0].length, 2);
  }],
  ["m2: MORE ignored", "if (!(flags & 1)) {", "if (true) {", (Zm) => {
    const s = cat([Zm.greeting(), ...Zm.readyCommand({ "Socket-Type": Buffer.from("ROUTER") }), ...Zm.encodeFrames(["a", "b"])]);
    const got: Buffer[][] = [];
    new Zm.Decoder({ greeting() {}, command() {}, message: (f) => got.push(f) }).push(s);
    assert.equal(got.length, 1);
  }],
  ["m3: a COMMAND frame taken as a message", "if (flags & 4) {", "if (flags & 0) {", (Zm) => {
    const s = cat([Zm.greeting(), ...Zm.readyCommand({ "Socket-Type": Buffer.from("ROUTER") })]);
    const cmds: string[] = [];
    new Zm.Decoder({ greeting() {}, command: (n) => cmds.push(n), message() {} }).push(s);
    assert.deepEqual(cmds, ["READY"]);
  }],
  ["m4: the subscription not resent on reconnect", "for (const s of this.subs) this.write(c, encodeFrames([s]));", "if (this.counters.attempts === 1) for (const s of this.subs) this.write(c, encodeFrames([s]));", async (Zm) => {
    const srv = await server("XPUB");
    const s = new Zm.Subscriber({ reconnectIvl: 20 });
    try {
      s.connect(srv.url);
      s.subscribe();
      await until(() => srv.peers[0]?.frames.length === 1);
      srv.peers[0].socket.destroy();
      await until(() => srv.peers[1]?.frames.length === 1, 1000, "the resent subscription");
    } finally {
      s.close();
      await srv.close();
    }
  }],
  ["m5: no handshake deadline", "this.fail(c, `no handshake within ${this.opts.handshakeIvl} ms`);", "void 0;", async (Zm) => {
    const srv = await server("ROUTER", "silent");
    const d = new Zm.Dealer({ routingId: "x", handshakeIvl: 200 });
    try {
      d.connect(srv.url);
      await until(() => d.counters.attempts >= 2, 2000, "a retry after the 200 ms deadline");
    } finally {
      d.close();
      await srv.close();
    }
  }],
  ["m6: no generation check", "const live = () => g === this.gen && !this._closed;", "const live = () => !this._closed;", async (Zm) => {
    const srv = await server("ROUTER");
    const made: net.Socket[] = [];
    const orig = rawNet.connect;
    rawNet.connect = (...a: any[]) => { const s = (orig as any)(...a); made.push(s); return s; };
    const d = new Zm.Dealer({ routingId: "x", reconnectIvl: 20 });
    try {
      d.connect(srv.url);
      d.send(["one"]);
      await until(() => srv.peers[0]?.frames.length === 1);
      srv.peers[0].socket.destroy();
      await until(() => srv.peers.length === 2 && made.length === 2);
      d.send(["two"]);
      await until(() => srv.peers[1].frames.length === 1, 2000);
      made[0].emit("data", cat(Zm.encodeFrames(["stale"])));
      await sleep(50);
      assert.equal(d.stats.queuedCount, 0, "a stale message was delivered");
    } finally {
      rawNet.connect = orig;
      d.close();
      await srv.close();
    }
  }],
  ["m7: a tiny body copied with Buffer.from (pooled)", "const dst = Buffer.allocUnsafeSlow(n);", "const dst = Buffer.from(Buffer.alloc(n));", (Zm) => {
    const s = cat([Zm.greeting(), ...Zm.readyCommand({ "Socket-Type": Buffer.from("ROUTER") }), ...Zm.encodeFrames(["x"])]);
    const big = Buffer.allocUnsafeSlow(65536);
    s.copy(big);
    const got: Buffer[][] = [];
    new Zm.Decoder({ greeting() {}, command() {}, message: (f) => got.push(f) }).push(big.subarray(0, s.length));
    assert.equal(got[0][0].buffer.byteLength, 1);
  }],
];

function loadMutant(from: string, to: string): typeof Z {
  const src = readFileSync(join(__dirname, "zmtp.ts"), "utf8");
  assert.equal(src.split(from).length, 2, `the mutant's text occurs once: ${from}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require(process.env.ZMTP_TS_API ?? "typescript");
  const js = ts.transpileModule(src.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "zmtp-mutant-"));
  const file = join(dir, "zmtp.js");
  writeFileSync(file, js);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("mutants (fail-first evidence)", () => {
  test("the unmutated module passes every mutant's check", async () => {
    for (const [, , , check] of MUTANTS) await check(Z);
  });
  for (const [name, from, to, check] of MUTANTS) {
    test(`${name}: fails its check`, async () => {
      const Zm = loadMutant(from, to);
      let failed = false;
      try {
        await check(Zm);
      } catch {
        failed = true;
      }
      assert.ok(failed, `${name} survived`);
    });
  }
});
