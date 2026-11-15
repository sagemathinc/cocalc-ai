/*
Finding 028 B-2 tests: can the page cache of a file in this test directory be
dropped at all?  The real-eviction tests need that (DONTNEED + mincore = 0).
On some filesystems it can't be (CI runners: "16 pages still resident"); B
then refuses verification, fail closed, as designed, and those tests can only
be skipped there.  The slot-B DEV runs them in full and gates on that.

The probe runs the REAL helper, synchronously (at test definition time, so a
skip is a real Jest skip), on a 64 KiB fsync'd file in a fresh directory under
the same parent the tests use.  Only one outcome skips: the helper ran and
reported pages still resident.  Anything else (no interpreter, a spawn error,
a timeout, a nonzero exit, stderr, an unparsable line) is an ERROR: the tests
stay registered and fail with it.  No cache, no environment override.
*/

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  PYTHON,
  PYTHON_ARGS,
  parseHelperOutput,
  readCheckedHelper,
} from "@cocalc/backend/conat/persist-verified-eviction";

export type EvictableProbe =
  | { kind: "evictable"; fstype: string }
  | { kind: "not-evictable"; fstype: string; why: string }
  | { kind: "error"; error: string };

const SIZE = 64 * 1024;
const PAGES = SIZE / 4096;

// the filesystem type of path, from /proc/self/mountinfo (the mount with the
// longest mount point that contains the path's realpath)
export function fstypeOf(path: string): string {
  const real = fs.realpathSync(path);
  let best = "";
  let type = "unknown";
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const fields = line.slice(0, sep).split(" ");
    const mount = (fields[4] ?? "").replace(/\\([0-7]{3})/g, (_m, o) =>
      String.fromCharCode(parseInt(o, 8)),
    );
    const inside = real === mount || real.startsWith(mount === "/" ? "/" : `${mount}/`);
    if (inside && mount.length >= best.length) {
      best = mount;
      type = line.slice(sep + 3).split(" ")[0] || "unknown";
    }
  }
  return type;
}

export interface HelperRunResult {
  error?: Error;
  signal: string | null;
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

// The probe's verdict on one helper run (pure; unit-tested).  ONLY a clean
// run that reports pages still resident is "not-evictable".
export function classifyHelperRun(
  r: HelperRunResult,
  fstype: string,
  pages: number = PAGES,
): EvictableProbe {
  if (r.error) return { kind: "error", error: `spawn: ${r.error.message}` };
  if (r.signal) return { kind: "error", error: `helper killed by ${r.signal}` };
  if (r.status !== 0) return { kind: "error", error: `helper exit ${r.status}` };
  if (r.stderr.length > 0) {
    return { kind: "error", error: `helper stderr: ${r.stderr.toString().slice(0, 200)}` };
  }
  const parsed = parseHelperOutput(r.stdout.toString(), pages);
  if (parsed == null) {
    return { kind: "error", error: `unparsable helper output: ${r.stdout.toString().slice(0, 200)}` };
  }
  if (parsed.resident === 0) return { kind: "evictable", fstype };
  return { kind: "not-evictable", fstype, why: `${parsed.resident} pages still resident` };
}

export function probeEvictable(parent: string): EvictableProbe {
  if (!fs.existsSync(PYTHON)) {
    return { kind: "error", error: `${PYTHON} does not exist` };
  }
  const program = readCheckedHelper();
  if (program == null) {
    return { kind: "error", error: "the helper's sha256 differs" };
  }
  let dir: string | undefined;
  let fd: number | undefined;
  try {
    dir = fs.mkdtempSync(join(parent, "persist-028-probe-"));
    const file = join(dir, "probe.db");
    fs.writeFileSync(file, Buffer.alloc(SIZE, 1));
    fd = fs.openSync(file, "r");
    fs.fsyncSync(fd);
    fs.readFileSync(file); // resident now
    const fstype = fstypeOf(dir);
    const r = spawnSync(PYTHON, PYTHON_ARGS, {
      input: program,
      stdio: ["pipe", "pipe", "pipe", fd],
      env: {},
      cwd: "/",
      shell: false,
      timeout: 20_000,
    });
    return classifyHelperRun(r, fstype);
  } catch (err) {
    return { kind: "error", error: `${err}` };
  } finally {
    if (fd != null) fs.closeSync(fd);
    if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `it` for a test that needs real eviction in that directory: a real Jest
// skip (with one reason line) only where the probe saw pages still resident;
// on a probe error the test is registered and fails with that error.
export function evictionIt(probe: EvictableProbe) {
  if (probe.kind === "evictable") return it;
  if (probe.kind === "not-evictable") {
    console.warn(`test dir not evictable: ${probe.fstype}; why: ${probe.why}`);
    return it.skip;
  }
  return (name: string, _fn?: any, timeout?: number) =>
    it(
      name,
      () => {
        throw new Error(`the eviction probe failed: ${probe.error}`);
      },
      timeout,
    );
}
