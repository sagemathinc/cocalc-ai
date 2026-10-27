/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A real ipykernel through cocalc's own Kernel class, on the transport
COCALC_JUPYTER_ZMQ selects (js by default; CI runs it again with "native"):
outputs of at least 64 MiB on stdout and as display_data, an error output,
stdin, an interrupt by SIGINT and one by interrupt_request on the control
channel, and the process's resources (sockets and timers) back to their
baseline after a restart, a shutdown and a kernel that dies.

pnpm test `pwd`/zmtp-conformance.test.ts
*/

import { transport } from "../../zmq/transport";
import { getPythonKernel, closeKernels } from "./util";

const MIB64 = 2 ** 26;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// every active resource but the terminal's, by kind
const resources = () => {
  const m = new Map<string, number>();
  for (const r of process.getActiveResourcesInfo())
    if (r !== "TTYWrap") m.set(r, (m.get(r) ?? 0) + 1);
  return m;
};
async function backToBaseline(
  base: Map<string, number>,
  ms = 10_000,
): Promise<string> {
  let now = resources();
  for (const t0 = Date.now(); Date.now() - t0 < ms; now = resources()) {
    if ([...now].every(([k, n]) => n <= (base.get(k) ?? 0))) return "";
    await sleep(50);
  }
  return JSON.stringify({
    baseline: Object.fromEntries(base),
    now: Object.fromEntries(now),
  });
}

async function run(k, code: string, opts: any = {}) {
  const out: any[] = [];
  const output = k.execute_code({ code, ...opts });
  for await (const x of output.iter()) out.push(x);
  return out;
}

// the pure-JS transport's own sockets of a kernel (for its reconnect counters)
const jsSockets = (k): any[] =>
  transport().name === "js"
    ? Object.values((k.sockets as any)?.sockets ?? {})
    : [];

describe("the transport", () => {
  it("is the one COCALC_JUPYTER_ZMQ selects", () => {
    expect(transport().name).toBe(process.env.COCALC_JUPYTER_ZMQ || "js");
  });
});

describe("an ipykernel on this transport", () => {
  let k;
  let baseline: Map<string, number>;

  it("spawns, and answers kernel_info", async () => {
    baseline = resources();
    k = await getPythonKernel("zmtp-conformance-1.ipynb");
    await k.spawn();
    const info = await k.kernel_info();
    expect(info.language_info?.name).toBe("python");
  });

  it("streams 64 MiB of stdout, whole", async () => {
    const out = await run(k, `print("x" * ${MIB64}, end="")`);
    const text = out
      .filter((m) => m.content?.name === "stdout")
      .map((m) => m.content.text)
      .join("");
    expect(text.length).toBe(MIB64);
  }, 120_000);

  it("delivers a 64 MiB display_data", async () => {
    const out = await run(
      k,
      `from IPython.display import display\ndisplay({"text/plain": "y" * ${MIB64}}, raw=True)`,
    );
    const d = out.find((m) => m.content?.data?.["text/plain"]?.length >= MIB64);
    expect(d).toBeTruthy();
  }, 120_000);

  it("reports an error output", async () => {
    const out = await run(k, "1/0");
    const e = out.find((m) => m.content?.ename != null);
    expect(e?.content.ename).toBe("ZeroDivisionError");
  });

  it("reads stdin", async () => {
    const asked: string[] = [];
    const out = await run(k, "a = input('name: ')\nprint('hello', a)", {
      stdin: async (prompt: string) => {
        asked.push(prompt);
        return "zmtp";
      },
    });
    expect(asked).toEqual(["name: "]);
    expect(JSON.stringify(out)).toContain("hello zmtp");
  });

  it("is interrupted by SIGINT", async () => {
    const output = k.execute_code({ code: "import time\ntime.sleep(100)" });
    const msgs: any[] = [];
    const done = (async () => {
      for await (const x of output.iter()) msgs.push(x);
    })();
    await sleep(1500);
    k.signal("SIGINT");
    await done;
    expect(JSON.stringify(msgs)).toContain("KeyboardInterrupt");
  }, 30_000);

  // the only use of the control channel (kernel.ts: interrupt_mode "message")
  it("is interrupted by an interrupt_request on the control channel", async () => {
    const spec = k._kernel.kernel_spec;
    const saved = spec.interrupt_mode;
    spec.interrupt_mode = "message";
    try {
      const output = k.execute_code({ code: "import time\ntime.sleep(100)" });
      void (async () => {
        for await (const _ of output.iter());
      })();
      await sleep(1500);
      k.signal("SIGINT"); // sent as interrupt_request on control
      // the kernel is free again: a new execution finishes in seconds, not after the 100 s sleep
      const t0 = Date.now();
      const out = await run(k, "1 + 1");
      expect(out.find((m) => m.content?.data)?.content.data).toEqual({
        "text/plain": "2",
      });
      expect(Date.now() - t0).toBeLessThan(20_000);
    } finally {
      spec.interrupt_mode = saved;
    }
  }, 60_000);

  it("shuts down, and a new kernel (a restart) works on fresh sockets; resources back to baseline", async () => {
    const old = jsSockets(k);
    k.close();
    k = await getPythonKernel("zmtp-conformance-2.ipynb");
    await k.spawn();
    const out = await run(k, "1 + 1");
    expect(out.find((m) => m.content?.data)?.content.data).toEqual({
      "text/plain": "2",
    });
    for (const s of old) {
      expect(s.closed).toBe(true);
      expect(s.counters.attemptsAfterClose).toBe(0);
    }
    k.close();
    expect(await backToBaseline(baseline)).toBe("");
  }, 60_000);

  it("a kernel that dies: its sockets close, no reconnect after, resources back to baseline", async () => {
    k = await getPythonKernel("zmtp-conformance-3.ipynb");
    await k.spawn();
    await run(k, "1 + 1");
    const socks = jsSockets(k);
    process.kill(k.pid(), "SIGKILL");
    for (let i = 0; i < 200 && k.sockets != null; i++) await sleep(50);
    expect(k.sockets).toBeFalsy();
    await sleep(500); // several reconnect intervals
    for (const s of socks) {
      expect(s.closed).toBe(true);
      expect(s.counters.attemptsAfterClose).toBe(0);
    }
    expect(await backToBaseline(baseline)).toBe("");
  }, 60_000);
});

afterAll(() => {
  closeKernels();
});
