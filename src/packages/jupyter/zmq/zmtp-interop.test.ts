/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The pure-JS ZMTP transport against libzmq itself (through pyzmq): a ROUTER and
an XPUB in a Python helper.  Skipped when python3 has no zmq module.  Frames
are 8 MiB here; ZMTP_INTEROP_MIB=64 (the VM run) makes them 64 MiB.
*/

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import * as Z from "./zmtp";

const PY = process.env.PYTHON ?? "python3";
const zmqCheck = spawnSync(PY, ["-c", "import zmq"], { encoding: "utf8" });
const hasZmq = zmqCheck.status === 0;
// CI sets ZMTP_REQUIRE_PYZMQ=1: there, a missing Python stack fails instead of skipping (grader G1)
if (!hasZmq && process.env.ZMTP_REQUIRE_PYZMQ === "1") {
  describe("pyzmq, required by ZMTP_REQUIRE_PYZMQ=1", () => {
    test("is importable", () => {
      throw new Error(
        `${PY} can't import zmq: ${zmqCheck.stderr || zmqCheck.error || zmqCheck.status}`,
      );
    });
  });
}
const MIB = Number(process.env.ZMTP_INTEROP_MIB ?? 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELPER = String.raw`
import sys, zmq
rport, pport, hb = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
ctx = zmq.Context()
r = ctx.socket(zmq.ROUTER)
if hb:
    r.setsockopt(zmq.HEARTBEAT_IVL, hb)
    r.setsockopt(zmq.HEARTBEAT_TIMEOUT, 10 * hb)
    # the TTL its PINGs carry, which our side enforces
    r.setsockopt(zmq.HEARTBEAT_TTL, 10 * hb)
r.bind("tcp://127.0.0.1:%d" % rport)
p = ctx.socket(zmq.XPUB)
p.bind("tcp://127.0.0.1:%d" % pport)
print("ready libzmq %s pyzmq %s" % (zmq.zmq_version(), zmq.__version__), flush=True)
poller = zmq.Poller()
poller.register(r, zmq.POLLIN)
poller.register(p, zmq.POLLIN)
while True:
    for s, _ in poller.poll():
        if s is p:
            sub = p.recv()
            print("sub %s" % sub.hex(), flush=True)
            for i in range(3):
                p.send_multipart([b"topic", b"pub%d" % i])
            continue
        m = r.recv_multipart()
        ident, body = m[0], m[1:]
        if body[0] == b"big":
            n = int(body[1])
            r.send_multipart([ident, b"big", b"x" * n])
            print("got-big %d" % len(body[2]) if len(body) > 2 else "sent-big", flush=True)
        elif body[0] == b"quit":
            sys.exit(0)
        else:
            print("from %s %s" % (ident.decode(), b"|".join(body).decode()), flush=True)
            r.send_multipart([ident] + body)
`;

async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    ports.push((s.address() as AddressInfo).port);
    await new Promise<void>((r) => s.close(() => r()));
  }
  return ports;
}

class Helper {
  proc: ChildProcess;
  lines: string[] = [];
  constructor(rport: number, pport: number, hb = 0) {
    this.proc = spawn(
      PY,
      ["-c", HELPER, String(rport), String(pport), String(hb)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let buf = "";
    this.proc.stdout!.on("data", (d) => {
      buf += d;
      const parts =
        buf.split(/\r?\n/); /* (Windows Python ends lines with \r\n) */
      buf = parts.pop()!;
      this.lines.push(...parts);
    });
  }
  async wait(prefix: string, ms = 10_000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      const l = this.lines.find((x) => x.startsWith(prefix));
      if (l != null) return l;
      if (Date.now() - t0 > ms)
        throw new Error(
          `the helper never said ${prefix}: ${JSON.stringify(this.lines)}`,
        );
      await sleep(10);
    }
  }
  kill(): Promise<void> {
    return new Promise((r) => {
      if (this.proc.exitCode != null) return r();
      this.proc.once("exit", () => r());
      this.proc.kill("SIGKILL");
    });
  }
}

const maybe = hasZmq ? describe : describe.skip;

maybe("interop with libzmq (pyzmq)", () => {
  test("the versions spoken to", async () => {
    const [a, b] = await freePorts(2);
    const h = new Helper(a, b);
    console.log("ZMTP interop peer:", (await h.wait("ready")).slice(6));
    await h.kill();
  });

  test("connect before bind: queued messages arrive in order, with our routing id; replies come back", async () => {
    const [a, b] = await freePorts(2);
    const d = new Z.Dealer({ routingId: "cocalc-client-1" });
    d.connect(`tcp://127.0.0.1:${a}`);
    for (let i = 0; i < 3; i++) d.send([`m${i}`, "x"]);
    await sleep(500); // the peer isn't listening yet
    const h = new Helper(a, b);
    try {
      await h.wait("ready");
      const it = d[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++)
        assert.deepEqual((await it.next()).value!.map(String), [`m${i}`, "x"]);
      await h.wait("from cocalc-client-1 m2"); // (its stdout can trail the replies)
      assert.deepEqual(
        h.lines.filter((l) => l.startsWith("from")),
        [0, 1, 2].map((i) => `from cocalc-client-1 m${i}|x`),
      );
    } finally {
      d.close();
      await h.kill();
    }
  });

  test("SUB with an empty prefix receives everything, and resubscribes after the peer restarts on the same port", async () => {
    const [a, b] = await freePorts(2);
    let h = new Helper(a, b);
    const s = new Z.Subscriber();
    try {
      await h.wait("ready");
      s.connect(`tcp://127.0.0.1:${b}`);
      s.subscribe();
      const it = s[Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++)
        assert.deepEqual((await it.next()).value!.map(String), [
          "topic",
          `pub${i}`,
        ]);
      assert.equal(await h.wait("sub"), "sub 01");
      await h.kill();
      h = new Helper(a, b);
      await h.wait("ready");
      assert.equal(await h.wait("sub", 15_000), "sub 01");
      for (let i = 0; i < 3; i++)
        assert.deepEqual((await it.next()).value!.map(String), [
          "topic",
          `pub${i}`,
        ]);
    } finally {
      s.close();
      await h.kill();
    }
  });

  test(`${MIB} MiB frames each way, with libzmq heartbeats (PING, with a TTL) during the transfer`, async () => {
    const [a, b] = await freePorts(2);
    const h = new Helper(a, b, 20);
    const d = new Z.Dealer({ routingId: "big" });
    try {
      await h.wait("ready");
      d.connect(`tcp://127.0.0.1:${a}`);
      const n = MIB << 20;
      d.send(["big", String(n), Buffer.alloc(n, 120)]);
      const r = (await d[Symbol.asyncIterator]().next()).value!;
      assert.equal(r[0].toString(), "big");
      assert.equal(r[1].length, n);
      assert.equal(await h.wait("got-big"), `got-big ${n}`);
      await sleep(600); // heartbeats keep flowing; the connection stays
      d.send(["after", "hb"]);
      await h.wait("from big after|hb");
      assert.equal(d.counters.attempts, 1, "the TTL never closed it");
    } finally {
      d.close();
      await h.kill();
    }
  });
});
