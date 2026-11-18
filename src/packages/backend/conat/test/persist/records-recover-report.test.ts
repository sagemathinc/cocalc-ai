/*
The recovery command's report is written completely before the process ends
(review B8, SA 4315): stdout to a pipe is asynchronous on POSIX, so the
command ends from the write's callback, never with process.exit() right
after it.  A child process (the built backend) writes a report larger than
a pipe buffer (64 KiB) to a reader that pauses; the reader gets all of it,
and the exact exit code.  [RECOVERY-REPORT]
*/

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BACKEND_DIST = join(__dirname, "..", "..", "..", "dist");

const CHILD = `
const [dist] = process.argv.slice(1);
const { writeReportAndExit } = require(dist + "/conat/persist-records-recover.js");
const plan = [];
for (let i = 0; i < 3000; i++) plan.push("/a/long/enough/path/to/a/records/entry/" + i + "/" + "x".repeat(40));
const out = JSON.stringify({ ok: true, plan, applied: [] }, null, 2) + "\\n";
writeReportAndExit(out, 3);
`;

function run(): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", CHILD, BACKEND_DIST], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    // a slow reader: nothing is read for a while, so the pipe fills up
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 700);
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
  });
}

describe("[RECOVERY-REPORT-unit] the process ends only from the write's callback", () => {
  it("[RECOVERY-REPORT-unit] exit is not called before the stream reports the write done, then exactly once with the code", async () => {
    const { writeReportAndExit } = require("@cocalc/backend/conat/persist-records-recover");
    const calls: string[] = [];
    let done: (() => void) | undefined;
    const stream = {
      write: (s: string, cb: () => void) => {
        calls.push(`write ${s.length}`);
        done = cb; // completes later, like a pipe
        return false;
      },
    };
    const saved = process.exitCode;
    try {
      writeReportAndExit("x".repeat(100_000), 4, stream, (c: number) => calls.push(`exit ${c}`));
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual(["write 100000"]);
      expect(process.exitCode).toBe(4);
      done!();
      expect(calls).toEqual(["write 100000", "exit 4"]);
    } finally {
      process.exitCode = saved;
    }
  });
});

describe("[RECOVERY-REPORT] the recovery report is never truncated", () => {
  beforeAll(() => {
    if (!existsSync(join(BACKEND_DIST, "conat", "persist-records-recover.js"))) {
      throw Error(`build the backend first: no ${BACKEND_DIST}`);
    }
  });

  it("[RECOVERY-REPORT] more than a pipe buffer, a paused reader: complete JSON and the exact exit code", async () => {
    const { code, text } = await run();
    expect(text.length).toBeGreaterThan(64 * 1024);
    const report = JSON.parse(text);
    expect(report.plan).toHaveLength(3000);
    expect(code).toBe(3);
  });
});
