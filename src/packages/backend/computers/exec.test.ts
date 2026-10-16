/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExecRequest } from "@cocalc/util/computers/operations";
import { runExec } from "./exec";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "computer-exec-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opts = () => ({ workdir: dir, shell: "/bin/sh", killGraceMs: 500 });
const run = (input: object, extra: object = {}) =>
  runExec(parseExecRequest(input), { ...opts(), ...extra });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(f: () => boolean, timeout = 10_000) {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a shell line, its output and exit code, in the working directory", async () => {
  const r = await run({ command: "pwd; echo err >&2; exit 3" });
  expect(r).toMatchObject({
    exit_code: 3,
    stdout: `${dir}\n`,
    stderr: "err\n",
    timed_out: false,
    cancelled: false,
    truncated: false,
  });
});

test("argv runs exactly, with no shell parsing its values", async () => {
  const r = await run({ argv: ["printf", "%s|", "a b", "$HOME", "it's", "*"] });
  expect(r.stdout).toBe("a b|$HOME|it's|*|");
});

test("stdin, and a relative cwd that must exist", async () => {
  const r = await run({
    command: "cat",
    stdin: Buffer.from("in").toString("base64"),
  });
  expect(r.stdout).toBe("in");
  await expect(run({ command: "true", cwd: "nope" })).rejects.toThrow(
    "no such directory",
  );
});

test("output past the cap is dropped, and the command still finishes", async () => {
  const r = await run(
    { command: "head -c 100000 /dev/zero | tr '\\\\0' x" },
    { maxOutputBytes: 1000 },
  );
  expect(r.stdout.length).toBe(1000);
  expect(r.truncated).toBe(true);
  expect(r.exit_code).toBe(0);
});

test("a timeout kills the whole process group", async () => {
  const pidFile = join(dir, "child.pid");
  const r = await run({
    command: `sleep 30 & echo $! > ${pidFile}; wait`,
    timeout_ms: 500,
  });
  expect(r.timed_out).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => !alive(pid));
});

test("aborting stops it (revoked, or the connector stops)", async () => {
  const stop = new AbortController();
  const pidFile = join(dir, "abort.pid");
  const pending = run(
    { command: `echo $$ > ${pidFile}; exec sleep 30` },
    { signal: stop.signal },
  );
  await until(() => existsSync(pidFile));
  stop.abort();
  const r = await pending;
  expect(r.cancelled).toBe(true);
  expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
});
