/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A real ipykernel through cocalc's own Kernel class, on the transport
COCALC_JUPYTER_ZMQ selects (js by default; CI runs it again with "native"):
outputs of at least 64 MiB on stdout and as display_data, stdin, an
interrupt by SIGINT, a restart, and no sockets left after close.

pnpm test `pwd`/zmtp-conformance.test.ts
*/

import { transport } from "../../zmq/transport";
import { getPythonKernel, closeKernels } from "./util";

const MIB64 = 2 ** 26;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tcpSockets = () =>
  process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;

async function run(k, code: string, opts: any = {}) {
  const out: any[] = [];
  const output = k.execute_code({ code, ...opts });
  for await (const x of output.iter()) out.push(x);
  return out;
}

describe("the transport", () => {
  it("is the one COCALC_JUPYTER_ZMQ selects", () => {
    expect(transport().name).toBe(process.env.COCALC_JUPYTER_ZMQ || "js");
  });
});

describe("an ipykernel on this transport", () => {
  let k;
  let baseline = 0;

  it("spawns, and answers kernel_info", async () => {
    baseline = tcpSockets();
    k = await getPythonKernel("zmtp-conformance-1.ipynb");
    await k.spawn();
    const info = await k.kernel_info();
    expect(info.language_info?.name).toBe("python");
  });

  it("streams 64 MiB of stdout, whole", async () => {
    const out = await run(k, `print("x" * ${MIB64}, end="")`);
    const text = out
      .filter((m) => m.msg_type === "stream" || m.header?.msg_type === "stream")
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

  it("closes, and a new kernel (a restart) works on fresh sockets", async () => {
    k.close();
    k = await getPythonKernel("zmtp-conformance-2.ipynb");
    await k.spawn();
    const out = await run(k, "1 + 1");
    expect(out.find((m) => m.content?.data)?.content.data).toEqual({
      "text/plain": "2",
    });
    k.close();
  });

  it("leaves no socket behind", async () => {
    for (let i = 0; i < 100 && tcpSockets() > baseline; i++) await sleep(20);
    expect(tcpSockets()).toBeLessThanOrEqual(baseline);
  });
});

afterAll(() => {
  closeKernels();
});
