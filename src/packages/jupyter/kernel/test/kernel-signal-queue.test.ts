/*
Signals (interrupt, and the SIGKILL that restart/halt send) clear the
execution queue: the executions behind its head end, and the head finishes on
its own.  An execution must never be left waiting forever.

pnpm test `pwd`/kernel-signal-queue.test.ts
*/

import { getPythonKernel, closeKernels } from "./util";

type Outcome = "done" | "timeout" | `error: ${string}`;

async function outcome(
  output,
  ms = 15000,
): Promise<{ outcome: Outcome; mesgs: any[] }> {
  const mesgs: any[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    (async () => {
      for await (const mesg of output.iter()) mesgs.push(mesg);
      return "done" as const;
    })().catch((err) => `error: ${err}` as const),
    new Promise<"timeout">(
      (resolve) => (timer = setTimeout(() => resolve("timeout"), ms)),
    ),
  ]);
  clearTimeout(timer);
  return { outcome: result, mesgs };
}

const results = (mesgs: any[]) =>
  mesgs
    .map((mesg) => mesg.content?.data?.["text/plain"])
    .filter((x) => x != null);

afterAll(closeKernels);

describe("restart (SIGKILL) while the kernel is still starting", () => {
  it("ends the execution that was waiting for it", async () => {
    const k = await getPythonKernel("signal-queue-starting.ipynb");
    const output = k.execute_code({ code: "1+1" });
    for (let i = 0; i < 500 && !k.pid(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(k.pid()).toBeTruthy();
    expect(k.get_state()).not.toBe("running");
    k.signal("SIGKILL");
    // before: the signal dropped this execution from the queue, so it
    // waited forever (and the next queue run hit an undefined head)
    expect((await outcome(output)).outcome).toBe("done");
    expect(k.get_state()).toBe("closed");
  });

  it("a new kernel for the same notebook then runs code", async () => {
    const k = await getPythonKernel("signal-queue-starting.ipynb", true);
    const { outcome: o, mesgs } = await outcome(
      k.execute_code({ code: "2+2" }),
      30000,
    );
    expect(o).toBe("done");
    expect(results(mesgs)).toEqual(["4"]);
    k.close();
  });
});

describe("interrupting a running execution", () => {
  it("runs an execution queued after the interrupt, once the interrupted one stops", async () => {
    const k = await getPythonKernel("signal-queue-interrupt.ipynb");
    await outcome(k.execute_code({ code: "1" }), 30000);
    const running = k.execute_code({
      code: "import time; time.sleep(30)",
      halt_on_error: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    k.signal("SIGINT");
    const next = k.execute_code({ code: "7*6", halt_on_error: false });
    const [a, b] = await Promise.all([outcome(running), outcome(next)]);
    expect(a.outcome).toBe("done");
    expect(b.outcome).toBe("done");
    expect(results(b.mesgs)).toEqual(["42"]);
    k.close();
  });
});
