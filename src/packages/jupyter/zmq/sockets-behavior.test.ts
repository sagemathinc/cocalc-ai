/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
JupyterSockets (./index.ts) on the transport COCALC_JUPYTER_ZMQ selects,
against libzmq (pyzmq ROUTERs and an XPUB), for the behaviors PR-A keeps or
records rather than changes (plan-cocalc-pure-js-zmtp r4, sections b.5, b.6):

- overlapping, un-awaited sends to a kernel that isn't listening yet: how
  many arrive, and whether the transport rejected any (recorded per
  transport; the pure-JS one delivers all of them);
- a signed message whose JSON is malformed: Message._decode catches it and
  null is emitted, and the loop goes on; a listener that throws: that
  channel's loop ends and its listen task rejects.  The same on either
  transport, as before.

Skipped when python3 has no zmq module.
*/

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { jupyterSockets, type JupyterConnectionInfo } from "./index";
import { transport } from "./transport";

const PY = process.env.PYTHON ?? "python3";
const hasZmq = spawnSync(PY, ["-c", "import zmq"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "a-test-key";

const HELPER = String.raw`
import sys, zmq, hmac, hashlib, json, time
shell, iopub, stdin, control, key, mode = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5].encode(), sys.argv[6]
ctx = zmq.Context()
r = ctx.socket(zmq.ROUTER); r.bind("tcp://127.0.0.1:%d" % shell)
others = []
for port, kind in ((stdin, zmq.ROUTER), (control, zmq.ROUTER), (iopub, zmq.XPUB)):
    s = ctx.socket(kind); s.bind("tcp://127.0.0.1:%d" % port); others.append(s)
print("ready", flush=True)
def signed(parts):
    h = hmac.new(key, digestmod=hashlib.sha256)
    for p in parts: h.update(p)
    return [b"<IDS|MSG>", h.hexdigest().encode()] + parts
hdr = lambda: json.dumps({"msg_id": "m", "msg_type": "status", "session": "s", "username": "u", "version": "5.3", "date": ""}).encode()
if mode == "count":
    n, t0 = 0, time.time()
    r.RCVTIMEO = 500
    while time.time() - t0 < 8:
        try:
            r.recv_multipart(); n += 1
        except zmq.Again:
            if n: break
    print("count %d" % n, flush=True)
else:
    ident = r.recv_multipart()[0]
    if mode == "badjson":
        r.send_multipart([ident] + signed([hdr(), b"{}", b"{}", b"{bad json"]))
    r.send_multipart([ident] + signed([hdr(), b"{}", b"{}", b'{"n": 1}']))
    r.send_multipart([ident] + signed([hdr(), b"{}", b"{}", b'{"n": 2}']))
    print("sent", flush=True)
    time.sleep(3)
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

function helper(
  ports: number[],
  mode: string,
): { proc: ChildProcess; lines: string[] } {
  const proc = spawn(PY, ["-c", HELPER, ...ports.map(String), KEY, mode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: string[] = [];
  proc.stdout!.on("data", (d) =>
    lines.push(...String(d).split("\n").filter(Boolean)),
  );
  return { proc, lines };
}

async function line(h: { lines: string[] }, prefix: string, ms = 15_000) {
  const t0 = Date.now();
  while (!h.lines.some((l) => l.startsWith(prefix))) {
    if (Date.now() - t0 > ms)
      throw new Error(`no ${prefix}: ${JSON.stringify(h.lines)}`);
    await sleep(10);
  }
  return h.lines.find((l) => l.startsWith(prefix))!;
}

function config(ports: number[]): JupyterConnectionInfo {
  const [shell_port, iopub_port, stdin_port, control_port] = ports;
  return {
    version: 5,
    shell_port,
    iopub_port,
    stdin_port,
    control_port,
    hb_port: 1,
    ip: "127.0.0.1",
    key: KEY,
    signature_scheme: "hmac-sha256",
    transport: "tcp",
  };
}

const msg = (i: number) => ({
  channel: "shell",
  header: {
    msg_id: `m${i}`,
    username: "u",
    session: "s",
    msg_type: "kernel_info_request",
    version: "5.3",
    date: "",
  },
  parent_header: {},
  metadata: {},
  content: {},
});

const maybe = hasZmq ? describe : describe.skip;

maybe(
  `JupyterSockets on the ${process.env.COCALC_JUPYTER_ZMQ || "js"} transport`,
  () => {
    let rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    beforeEach(() => {
      rejections = [];
      process.on("unhandledRejection", onRejection);
    });
    afterEach(() => {
      process.off("unhandledRejection", onRejection);
    });

    test("2,000 overlapping un-awaited sends before the kernel listens: recorded", async () => {
      const ports = await freePorts(4);
      const s = await jupyterSockets(config(ports), "client-1");
      let threw = 0;
      for (let i = 0; i < 2000; i++) {
        try {
          s.send(msg(i) as any);
        } catch {
          threw++;
        }
      }
      await sleep(300);
      const h = helper(ports, "count");
      try {
        const n = Number((await line(h, "count", 20_000)).split(" ")[1]);
        console.log(
          `overlapping sends on ${transport().name}: ${n} of 2000 received, ${threw} threw, ${rejections.length} rejected`,
        );
        if (transport().name === "js") {
          expect(n).toBe(2000);
          expect(threw + rejections.length).toBe(0);
        } else {
          expect(n + threw + rejections.length).toBeGreaterThan(0);
        }
      } finally {
        s.close();
        h.proc.kill("SIGKILL");
      }
    }, 40_000);

    for (const mode of ["badjson", "throwing listener"] as const) {
      test(`${mode}: as before`, async () => {
        const ports = await freePorts(4);
        const h = helper(ports, mode === "badjson" ? "badjson" : "good");
        await line(h, "ready");
        const s = await jupyterSockets(config(ports), "client-2");
        // (observe the listen tasks' rejections directly, the same under any test runner)
        const failed: unknown[] = [];
        for (const t of (s as any).listenTasks as Promise<void>[])
          t.catch((e) => failed.push(e));
        const got: any[] = [];
        s.on("shell", (m) => {
          got.push(m?.content);
          if (mode === "throwing listener") throw new Error("a listener's bug");
        });
        try {
          s.send(msg(0) as any);
          await line(h, "sent");
          await sleep(500);
          if (mode === "badjson") {
            // Message._decode catches the parse error: null is emitted, and the loop goes on
            expect(got).toEqual([undefined, { n: 1 }, { n: 2 }]);
            expect(failed.length).toBe(0);
          } else {
            // the throw ends that channel's loop, and its listen task rejects
            expect(got).toEqual([{ n: 1 }]);
            expect(failed.length).toBe(1);
          }
        } finally {
          s.close();
          h.proc.kill("SIGKILL");
        }
      }, 30_000);
    }
  },
);
