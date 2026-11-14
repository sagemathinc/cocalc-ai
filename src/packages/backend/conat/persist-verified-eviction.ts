/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Verified page-cache eviction of a persist file (finding 028, DESIGN v1.21
§3.2.6 H-b, §3.2.11).

A dirty record left by another, dead, process generation means the outcome
of its last write is UNKNOWN: it may have consumed a sync error on its own fd
(errseq), leaving pages in the page cache that are not on disk, which a new
fd in this boot can neither see nor flush.  The page cache is made equal to
the disk instead: for each of the -wal and the .db,
  1. fsync (pages still dirty are written; this proves nothing about the
     phantoms, errseq);
  2. POSIX_FADV_DONTNEED, and
  3. mincore = 0 resident pages, VERIFIED (DONTNEED is best effort),
then 4. the -shm is removed, and the normal open's WAL recovery reads the
on-disk truth and drops an invalid tail.

Node exposes neither posix_fadvise nor mincore, so steps 2-3 run in a fixed
helper (persist-pagecache-helper.py) on a file descriptor this process opened
and checked; the helper never sees a path.  The helper's bytes are checked
against a pinned sha256 before every run and are written to the
interpreter's stdin (`/usr/bin/python3 -I -S -`), so nothing is re-read by
path between the check and the run.  Anything unexpected is NOT VERIFIED:
the stream stays refused and is retried later.  A failed verification is
never a poison and never has a host effect (§3.2.0).
*/

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { syncFiles } from "@cocalc/backend/data";
import { createFairLimiter, OPEN_BARRIER_CONCURRENCY } from "./persist-open-barrier";
import { integrityCheckClosedDatabase } from "./persist-durability";

const logger = getLogger("persist:verified-eviction");

// The helper program.  It ships inside this module (not as a separate file
// read by path): the bytes the parent checks are the bytes it runs, and no
// file can be swapped in between.  persist-pagecache-helper.py is the
// readable source; a test pins that this constant equals it byte for byte.
export const PAGECACHE_HELPER_PROGRAM = "# This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.\n# License: MS-RSL - see LICENSE.md for details\n#\n# The persist server's page-cache helper (finding 028, DESIGN v1.21 \u00a73.2.11).\n# It acts ONLY on file descriptor 3, which the persist server opened itself\n# (with its hostile-path checks) and passed in.  It reads no path, no argv and\n# no environment.  It drops the file's pages from the page cache\n# (POSIX_FADV_DONTNEED), then counts the pages still resident (mmap + mincore)\n# and prints exactly one line:\n#   {\"v\":1,\"page_size\":4096,\"pages\":<int>,\"resident_after\":<int>}\n# Run as `/usr/bin/python3 -I -S -`, with these exact bytes on stdin (the\n# server checks their sha256 first).  Stdlib only.\nimport ctypes\nimport mmap\nimport os\nimport sys\n\nFD = 3\nPAGE = 4096\n\n\ndef main():\n    size = os.fstat(FD).st_size\n    os.posix_fadvise(FD, 0, 0, os.POSIX_FADV_DONTNEED)\n    pages = (size + PAGE - 1) // PAGE\n    resident = 0\n    if size > 0:\n        libc = ctypes.CDLL(None, use_errno=True)\n        libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p]\n        libc.mincore.restype = ctypes.c_int\n        m = mmap.mmap(FD, size, mmap.MAP_SHARED, mmap.PROT_READ)\n        try:\n            vec = ctypes.create_string_buffer(pages)\n            addr = ctypes.addressof(ctypes.c_char.from_buffer(m))\n            if libc.mincore(ctypes.c_void_p(addr), ctypes.c_size_t(size), vec) != 0:\n                raise OSError(ctypes.get_errno(), \"mincore\")\n            resident = sum(1 for i in range(pages) if vec.raw[i] & 1)\n            del addr\n        finally:\n            try:\n                m.close()\n            except BufferError:\n                # an exported pointer: exit without closing (the process ends)\n                pass\n    sys.stdout.write(\n        '{\"v\":1,\"page_size\":%d,\"pages\":%d,\"resident_after\":%d}\\n'\n        % (PAGE, pages, resident)\n    )\n\n\nmain()\n";
// sha256 of the program, checked before every run
export const PAGECACHE_HELPER_SHA256 =
  "99170d2618993f1aac8fba46f3641082232763fdad55028a7ce1e333af766e05";
export const PYTHON = "/usr/bin/python3";
export const PYTHON_ARGS = ["-I", "-S", "-"];
export const HELPER_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 4096;
// bounded output: one short JSON line
const MAX_OUTPUT = 4096;

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export type EvictionResult =
  | { verified: true; files: string[] }
  | { verified: false; path: string; why: string };

function notVerified(path: string, why: string): EvictionResult {
  return { verified: false, path, why };
}

// The helper's bytes, checked against the pinned sha256 (undefined: refuse).
export function readCheckedHelper(
  program: string = PAGECACHE_HELPER_PROGRAM,
  sha256: string = PAGECACHE_HELPER_SHA256,
): Buffer | undefined {
  const bytes = Buffer.from(program, "utf8");
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === sha256 ? bytes : undefined;
}

// Strict: exactly the one expected line, with pages as the parent computed.
export function parseHelperOutput(
  stdout: string,
  expectedPages: number,
): { resident: number } | undefined {
  const m =
    /^\{"v":1,"page_size":(\d+),"pages":(\d+),"resident_after":(\d+)\}\n$/.exec(
      stdout,
    );
  if (m == null) return;
  const pageSize = Number(m[1]);
  const pages = Number(m[2]);
  const resident = Number(m[3]);
  if (pageSize !== PAGE_SIZE) return;
  if (pages !== expectedPages) return;
  if (!(resident >= 0 && resident <= pages)) return;
  return { resident };
}

export interface HelperRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  delivered: boolean;
  timedOut: boolean;
}

// Spawns the helper with fd as its fd 3 and the program on stdin.
export function runHelper(
  fd: number,
  program: Buffer,
  timeoutMs: number = HELPER_TIMEOUT_MS,
  spawnFn: typeof spawn = spawn,
): Promise<HelperRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let delivered = false;
    let timedOut = false;
    let settled = false;
    const child = spawnFn(PYTHON, PYTHON_ARGS, {
      shell: false,
      env: {},
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe", fd],
    });
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, delivered, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", () => finish(null, "spawn-error"));
    child.stdout?.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin?.on("error", () => {
      delivered = false;
    });
    // exactly the checked bytes, then end
    child.stdin?.write(program, (err) => {
      if (err == null) delivered = true;
    });
    child.stdin?.end();
  });
}

async function evictOne(
  path: string,
  dev: number,
  program: Buffer,
  spawnFn: typeof spawn,
): Promise<EvictionResult | "absent" | "ok"> {
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(path);
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return "absent";
    return notVerified(path, `lstat ${(err as any)?.code}`);
  }
  if (!before.isFile() || before.dev !== dev) {
    return notVerified(path, "not a regular file on the store's device");
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return notVerified(path, `open ${(err as any)?.code}`);
  }
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) {
      return notVerified(path, "replaced between lstat and open");
    }
    try {
      await handle.sync();
    } catch (err) {
      // a sync error here is a device signal, but verification only refuses
      // (§3.2.6): the file stays unverified and the stream refused
      return notVerified(path, `fsync ${(err as any)?.code}`);
    }
    const pages = Math.ceil(opened.size / PAGE_SIZE);
    const run = await runHelper(handle.fd, program, HELPER_TIMEOUT_MS, spawnFn);
    if (run.timedOut) return notVerified(path, "helper timed out");
    if (!run.delivered) return notVerified(path, "helper program not delivered");
    if (run.code !== 0 || run.signal != null) {
      return notVerified(path, `helper exit ${run.code} ${run.signal}`);
    }
    if (run.stderr.length > 0) return notVerified(path, "helper wrote stderr");
    const parsed = parseHelperOutput(run.stdout, pages);
    if (parsed == null) return notVerified(path, "helper output not valid");
    if (parsed.resident !== 0) {
      return notVerified(path, `${parsed.resident} pages still resident`);
    }
    return "ok";
  } finally {
    await handle.close().catch(() => {});
  }
}

// Steps 1-4 for one stream's files (dbPath = <path>.db).
export async function verifiedEviction(
  dbPath: string,
  opts: { program?: Buffer; spawnFn?: typeof spawn } = {},
): Promise<EvictionResult> {
  // an explicit program: undefined (a failed check) must not fall back
  const program = "program" in opts ? opts.program : readCheckedHelper();
  const spawnFn = opts.spawnFn ?? spawn;
  if (program == null) {
    return notVerified(dbPath, "helper missing or its sha256 differs");
  }
  let dirStats: fs.Stats;
  try {
    dirStats = await fs.promises.lstat(dirname(dbPath));
  } catch (err) {
    return notVerified(dbPath, `lstat dir ${(err as any)?.code}`);
  }
  if (!dirStats.isDirectory()) return notVerified(dbPath, "dir not a directory");
  const files: string[] = [];
  for (const path of [`${dbPath}-wal`, dbPath]) {
    const r = await evictOne(path, dirStats.dev, program, spawnFn);
    if (r === "absent") continue;
    if (r !== "ok") return r;
    files.push(path);
  }
  // 4. the -shm (a wal-index, rebuilt from the WAL at the next open)
  try {
    const shm = `${dbPath}-shm`;
    const st = await fs.promises.lstat(shm);
    if (!st.isFile()) return notVerified(shm, "not a regular file");
    await fs.promises.unlink(shm);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") {
      return notVerified(`${dbPath}-shm`, `remove ${(err as any)?.code}`);
    }
  }
  return { verified: true, files };
}

// Start-up presence check (§3.2.11): the helper on a scratch file in dir.
// false = verification is refused (fail closed) until fixed: an image defect.
export async function pagecacheHelperSelfTest(
  dir: string,
  opts: { program?: Buffer; spawnFn?: typeof spawn } = {},
): Promise<boolean> {
  const scratch = join(dir, `.pagecache-selftest-${process.pid}.db`);
  try {
    await fs.promises.writeFile(scratch, Buffer.alloc(64 * 1024, 1));
    const h = await fs.promises.open(scratch, "r+");
    try {
      await h.sync();
      await h.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    } finally {
      await h.close();
    }
    const r = await verifiedEviction(scratch, opts);
    if (!r.verified) {
      logger.error("persist: page-cache helper self-test failed (finding 028)", r);
    }
    return r.verified;
  } catch (err) {
    logger.error("persist: page-cache helper self-test failed (finding 028)", {
      err: `${err}`,
    });
    return false;
  } finally {
    await fs.promises.unlink(scratch).catch(() => {});
  }
}

// What the persist server uses: the start-up self-test once (on the persist
// data directory: a tmpfs scratch file can't be evicted, its pages ARE the
// file), then each verification under the same cap as the open barrier's
// fsyncs.  If the self-test failed, every verification is refused (fail
// closed): an image defect, which pages.
const limiter = createFairLimiter(OPEN_BARRIER_CONCURRENCY);
let selfTest: Promise<boolean> | undefined;
export async function checkedVerifiedEviction(
  dbPath: string,
): Promise<EvictionResult> {
  selfTest ??= pagecacheHelperSelfTest(syncFiles.local || dirname(dbPath));
  if (!(await selfTest)) {
    logger.error(
      "PERSIST ALERT (page): the page-cache helper self-test failed, so streams left mid-write stay refused (finding 028)",
    );
    return notVerified(dbPath, "page-cache helper self-test failed");
  }
  return await limiter.run(dirname(dbPath), () => verifiedEviction(dbPath));
}

// S-q's INVENTORY (§3.2.6, review R5): the project's persist files, from its
// store root, without following any symlink: only regular files named *.db
// or *.db-wal on the root's device.  Anything ambiguous (a symlink, a
// non-regular file other than a directory, another device) or more than max
// files: undefined, and the project stays poisoned.
export async function persistInventory(
  root: string,
  max = 10_000,
): Promise<string[] | undefined> {
  let rootStats: fs.Stats;
  try {
    rootStats = await fs.promises.lstat(root);
  } catch {
    return undefined;
  }
  if (!rootStats.isDirectory()) return undefined;
  const dbs = new Set<string>();
  let files = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(path);
      } catch {
        return false; // removed or replaced during the walk
      }
      if (st.dev !== rootStats.dev) return false;
      if (st.isSymbolicLink()) return false;
      if (st.isDirectory()) {
        if (!(await walk(path))) return false;
        continue;
      }
      if (!st.isFile()) return false;
      if (entry.name.endsWith(".db")) {
        dbs.add(path);
      } else if (entry.name.endsWith(".db-wal")) {
        dbs.add(path.slice(0, -"-wal".length));
      } else {
        continue; // -shm and anything else: not persist data
      }
      if (++files > max) return false;
    }
    return true;
  };
  if (!(await walk(root))) return undefined;
  return [...dbs].sort();
}

// S-q (§3.2.6): steps 1-4 (verified eviction) for every database of the
// inventory, then 5, a full integrity_check of each, off the main thread.
export async function recoverPoisonedProject(
  owner: string,
  storeRoot: string,
  {
    evict = checkedVerifiedEviction,
    check,
  }: {
    evict?: (dbPath: string) => Promise<EvictionResult>;
    check?: (dbPath: string) => Promise<{ ok: boolean; why?: string }>;
  } = {},
): Promise<{ ok: boolean; files?: string[]; why?: string }> {
  const inventory = await persistInventory(storeRoot);
  if (inventory == null) {
    return { ok: false, why: "inventory ambiguous or over its bound" };
  }
  const integrity = check ?? integrityCheckClosedDatabase;
  for (const db of inventory) {
    const evicted = await evict(db);
    if (!evicted.verified) {
      return { ok: false, why: `${evicted.path}: ${evicted.why}` };
    }
  }
  for (const db of inventory) {
    if (!fs.existsSync(db)) continue; // a -wal without its db: nothing to check
    const r = await integrity(db);
    if (!r.ok) return { ok: false, why: `${db}: integrity_check ${r.why}` };
  }
  logger.info("persist: S-q inventory verified (finding 028)", {
    owner,
    files: inventory.length,
  });
  return { ok: true, files: inventory };
}
