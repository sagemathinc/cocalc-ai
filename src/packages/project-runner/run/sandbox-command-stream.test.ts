import { runStreamingSandboxCommand } from "./sandbox-command-stream";
import { SANDBOX_COMMAND_SUPERVISOR } from "./sandbox-command-supervisor";
import { readFile } from "node:fs/promises";

function run(
  script: string,
  signal: AbortSignal,
  onOutput: (stream: "stdout" | "stderr", data: string) => void,
  timeoutMs = 10000,
) {
  return runStreamingSandboxCommand({
    command: process.execPath,
    args: ["-e", SANDBOX_COMMAND_SUPERVISOR, "--", script],
    env: { PATH: process.env.PATH },
    signal,
    timeoutMs,
    onOutput,
  });
}

test("streams output before exit without retaining a lifetime output buffer", async () => {
  const signal = new AbortController();
  let output = "";
  let first!: () => void;
  const seen = new Promise<void>((resolve) => {
    first = resolve;
  });
  let finished = false;
  const task = run(
    "printf first; sleep 0.2; printf second; exit 3",
    signal.signal,
    (_, data) => {
      output += data;
      first();
    },
  ).then((result) => {
    finished = true;
    return result;
  });
  await seen;
  expect(output).toBe("first");
  expect(finished).toBe(false);
  expect(await task).toMatchObject({ code: 3, stdout: "", stderr: "" });
  expect(output).toBe("firstsecond");
});

test("cancellation kills a supervised shell and child, not just the Podman client", async () => {
  const controller = new AbortController();
  let pid!: number;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const task = run(
    'sleep 60 & echo "$!"; wait',
    controller.signal,
    (_, data) => {
      pid = Number(data.trim());
      ready();
    },
  );
  await started;
  controller.abort();
  expect((await task).code).toBe(130);
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  expect(
    stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
  ).toBe(true);
});

test("streaming does not kill verbose commands at the old buffer limit", async () => {
  let bytes = 0;
  const result = await run(
    "head -c 2097152 /dev/zero",
    new AbortController().signal,
    (_, data) => {
      bytes += Buffer.byteLength(data);
    },
  );
  expect(result.code).toBe(0);
  expect(bytes).toBe(2097152);
});

(process.env.COCALC_TEST_LONG_JOBS === "1" ? test : test.skip)(
  "a real foreground job survives the former two-minute deadline",
  async () => {
    let output = "";
    const result = await run(
      "printf before; sleep 125; printf after",
      new AbortController().signal,
      (_, data) => {
        output += data;
      },
      140000,
    );
    expect(result.code).toBe(0);
    expect(output).toBe("beforeafter");
  },
  150000,
);
