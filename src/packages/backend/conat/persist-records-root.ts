/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The root of the 028 durability records (conat/persist/durability-records)
// on the persist's OWN disk, scoped by the kernel's boot id (ALT-D2, design
// note v8).  The records must be forgotten at a reboot (with the page cache
// they are about) and survive a persist restart.  They used to live on a
// root-provisioned tmpfs (/run/cocalc-persist); now they live in
//
//   <base>/records/<boot_id>/{dirty,poisoned-file,poisoned-project}/...
//
// where <base> is the role's own directory, outside every backed-up or
// restorable tree:
//   bay:          ${COCALC_BAY_STATE_DIR}/persist-durability
//   project host: ${COCALC_DATA}/persist-durability
// A boot dir of another boot is ignored (and pruned): that is what a reboot
// did to the tmpfs.
//
// The gate below runs once per process, BEFORE any record operation; every
// failure REFUSES disk streams (and pages); ephemeral streams still run.  It
// never throws.
//   1. the boot id: a canonical lowercase UUID, else refuse;
//   2. T1: every component from / to the base, records/ and the boot dir, and
//      to the post-reboot state dir (copy B's directory), is a real directory
//      (no symlink) owned by root or us and not group/other-writable; the
//      base, records/ and the boot dir are ours, mode 0700;
//   3. R-c: the base's realpath is not equal to or below a root that a
//      project container can see (tmpdir(), the cache root, the project
//      roots/image cache, the rootfs pull tmp, a project volume
//      <mountpoint>/project-*, the shared-scratch mount, /opt/cocalc);
//   4. R-b, the marker in two copies, A <base>/marker.json and B
//      <state>/records-marker.json, {boot_id, dev, ino, token} of the boot
//      dir, with the token also in <boot dir>/sentinel.json: the boot dir
//      deleted and re-created mid-boot (its records lost) is refused, see
//      the TOTAL table in evaluateOnce;
//   5. at the first start of this code on a host only (migration, a flag in
//      the state dir): the legacy tmpfs root must be absent or positively
//      empty, else refuse (its records belong to this boot);
//   6. other boots' dirs are pruned (well-formed ids only, no symlink
//      followed, bounded); a failed delete is logged, never "absent".
//
// The sentinel token is never published (diagnostics carry the path, dev/ino
// and the T1 result only), and it is not kept in the result.

import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { posix } from "node:path";

export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
export const DEFAULT_LEGACY_RUN_DIR = "/run/cocalc-persist";
export const RECORDS_BASE_NAME = "persist-durability";
export const RECORDS_DIR_NAME = "records";
export const MARKER_A_NAME = "marker.json";
export const MARKER_B_NAME = "records-marker.json";
export const SENTINEL_NAME = "sentinel.json";
export const MIGRATION_FLAG_NAME = "records-migrated.json";
export const LEGACY_RECORD_CLASSES = [
  "dirty",
  "poisoned-file",
  "poisoned-project",
] as const;
// prune at most this many entries per start (bounded); the rest next time
export const PRUNE_MAX_ENTRIES = 100_000;
// how long a start waits for another process's set-up of the same boot dir
// (two processes share a base: the persist and, on a project host, the
// file server's maintenance); re-reads only, a real fault stays refused
export const GATE_RETRY_MS = 100;
export const GATE_RETRIES = 30;
// env overrides, visible in diagnostics
export const TEST_PATHS_OVERRIDE = "COCALC_PERSIST_RECORDS_ALLOW_TEST_PATHS";
export const BASE_OVERRIDE = "COCALC_PERSIST_RECORDS_BASE";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^[0-9]{1,40}$/;

export function isBootId(s: unknown): s is string {
  return typeof s == "string" && UUID_RE.test(s);
}

// The file system calls the gate makes (node:fs; tests inject faults).
export interface GateFs {
  lstatSync: (path: string, opts: { bigint: true }) => nodeFs.BigIntStats;
  fstatSync: (fd: number, opts: { bigint: true }) => nodeFs.BigIntStats;
  mkdirSync: (path: string, opts: { mode: number }) => unknown;
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: "utf8") => string;
  openSync: (path: string, flags: number, mode?: number) => number;
  readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number | null) => number;
  writeSync: (fd: number, buf: Buffer, offset: number, length: number) => number;
  fchmodSync: (fd: number, mode: number) => void;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  rmdirSync: (path: string) => void;
  realpathSync: (path: string) => string;
}

export interface RecordsGate {
  ok: boolean;
  // refusal: a stable code and a human reason (never the token)
  code?: string;
  reason?: string;
  role?: "bay" | "project-host" | "explicit";
  base?: string;
  // the current boot's records root, only when ok
  root?: string;
  root_dev?: string;
  root_ino?: string;
  // "pass", "fail: <component>: <why>", or "not-run"
  t1: string;
  // this start created the boot dir: a new boot, or the migration
  new_boot?: boolean;
  migrated?: boolean;
  pruned?: number;
  prune_errors?: number;
  prune_skipped?: string[];
  prune_error_detail?: string[];
  overrides: string[];
}

export interface GateOptions {
  env?: NodeJS.ProcessEnv;
  fs?: GateFs;
  uid?: number;
  bootIdPath?: string;
  // the durable post-reboot state dir (persistStateDir()), copy B's dir
  stateDir?: string;
  // the data dir the mount builder uses (@cocalc/backend/data's data)
  dataDir?: string;
  token?: () => string;
  retries?: number;
  retryMs?: number;
  sleep?: (ms: number) => void;
  // unit tests of the gate only (never from env): the T1 walk starts here
  walkFrom?: string;
}

class Refuse extends Error {
  constructor(
    readonly code: string,
    message: string,
    // another process may be setting the same boot dir up: re-read
    readonly transient = false,
  ) {
    super(message);
  }
}

function errCode(err: unknown): string | undefined {
  return (err as any)?.code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The records base of this role, or undefined.
export function resolveRecordsBase(
  env: NodeJS.ProcessEnv = process.env,
): { base: string; role: "bay" | "project-host" | "explicit" } | undefined {
  if (env[BASE_OVERRIDE]) return { base: env[BASE_OVERRIDE]!, role: "explicit" };
  if (env.COCALC_BAY_STATE_DIR) {
    return {
      base: posix.join(env.COCALC_BAY_STATE_DIR, RECORDS_BASE_NAME),
      role: "bay",
    };
  }
  if (env.COCALC_DATA) {
    return {
      base: posix.join(env.COCALC_DATA, RECORDS_BASE_NAME),
      role: "project-host",
    };
  }
  return undefined;
}

// The legacy tmpfs root FINAL4 used (COCALC_PERSIST_RUN_DIR, else
// /run/cocalc-persist): only read, by the migration gate.
export function legacyRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COCALC_PERSIST_RUN_DIR || DEFAULT_LEGACY_RUN_DIR;
}

function isAbsoluteNormal(path: string): boolean {
  return (
    path.startsWith("/") &&
    posix.normalize(path) === path &&
    (path === "/" || !path.endsWith("/"))
  );
}

function isWithin(child: string, parent: string): boolean {
  if (parent === "/") return true;
  return child === parent || child.startsWith(`${parent}/`);
}

// T1 for one component: a real directory, owned by root or uid, not
// group/other-writable (a sticky world-writable /tmp is refused too).
function t1Component(fs: GateFs, path: string, uid: number): string | undefined {
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(path, { bigint: true });
  } catch (err) {
    return `lstat failed (${errCode(err) ?? err})`;
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not a directory";
  const owner = Number(st.uid);
  if (owner !== 0 && owner !== uid) return `owned by uid ${owner}`;
  const mode = Number(st.mode) & 0o7777;
  if ((mode & 0o022) !== 0) {
    return `group/other-writable (mode ${mode.toString(8)})`;
  }
  return undefined;
}

// mkdir path (one level, mode 0700) if lstat says it is missing; a racing
// creator is fine (EEXIST), the checks that follow decide.
function ensureDir(fs: GateFs, path: string): void {
  try {
    fs.lstatSync(path, { bigint: true });
    return;
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  try {
    fs.mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
}

// T1 walk of an absolute path: every component from / (or, under the test
// override, only the path itself) to path, creating missing components
// (0700).  Throws Refuse("t1_failed").  (walkFrom is "/" except in the
// gate's own unit tests, which walk a private test tree.)
function t1Walk(
  fs: GateFs,
  path: string,
  uid: number,
  ancestors: boolean,
  walkFrom: string,
): void {
  const parts = path.split("/").filter((x) => x);
  const prefixes: string[] = ["/"];
  for (let i = 1; i <= parts.length; i++) {
    prefixes.push("/" + parts.slice(0, i).join("/"));
  }
  const walked = ancestors ? prefixes.filter((p) => isWithin(p, walkFrom)) : [path];
  if (!ancestors) {
    // (the test override: missing ancestors are still created, unchecked)
    for (const p of prefixes.slice(0, -1)) {
      try {
        ensureDir(fs, p);
      } catch (err) {
        throw new Refuse("t1_failed", `fail: ${p}: missing and can't be created (${errCode(err) ?? err})`);
      }
    }
  }
  for (const p of walked) {
    try {
      ensureDir(fs, p);
    } catch (err) {
      throw new Refuse(
        "t1_failed",
        `fail: ${p}: missing and can't be created (${errCode(err) ?? err})`,
      );
    }
    const why = t1Component(fs, p, uid);
    if (why != null) throw new Refuse("t1_failed", `fail: ${p}: ${why}`);
  }
}

// one of ours, exactly: a real directory, our uid, mode 0700
function ownPrivateDir(fs: GateFs, path: string, uid: number): string | undefined {
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(path, { bigint: true });
  } catch (err) {
    return `lstat failed (${errCode(err) ?? err})`;
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not a directory";
  if (Number(st.uid) !== uid) return `owned by uid ${Number(st.uid)}, not ${uid}`;
  const mode = Number(st.mode) & 0o7777;
  if (mode !== 0o700) return `mode ${mode.toString(8)}, not 700`;
  return undefined;
}

// The roots a project container can see, resolved the way the mount builder
// resolves them (project-runner/run: rootfs.ts PROJECT_ROOTS, rootfs-base.ts
// IMAGE_CACHE and ROOTFS_PULL_TMPDIR, podman.ts tmpdir() mounts,
// shared-scratch.ts, mounts.ts /opt/cocalc), plus the project volumes
// <mountpoint>/project-* (filesystem.ts volumeName).  (R-c1, R-c2)
export function projectVisibleRoots(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): { kind: string; path: string }[] {
  return [
    { kind: "tmpdir", path: tmpdirOf(env) },
    { kind: "cache", path: posix.join(dataDir, "cache") },
    {
      kind: "project-roots",
      path: env.COCALC_PROJECT_ROOTS ?? posix.join(dataDir, "cache", "project-roots"),
    },
    {
      kind: "image-cache",
      path: env.COCALC_IMAGE_CACHE ?? posix.join(dataDir, "cache", "images"),
    },
    {
      kind: "rootfs-pull-tmp",
      path: env.COCALC_ROOTFS_PULL_TMPDIR ?? posix.join(dataDir, "tmp"),
    },
    {
      kind: "shared-scratch",
      path: `${env.COCALC_SHARED_SCRATCH_HOST_MOUNT ?? "/mnt/cocalc-scratch"}`.trim(),
    },
    { kind: "opt-cocalc", path: "/opt/cocalc" },
  ];
}

// os.tmpdir() of a process with env (node reads TMPDIR, then TMP, TEMP)
function tmpdirOf(env: NodeJS.ProcessEnv): string {
  if (env === process.env) return tmpdir();
  const t = env.TMPDIR || env.TMP || env.TEMP || "/tmp";
  return t.length > 1 && t.endsWith("/") ? t.slice(0, -1) : t;
}

export function projectVolumeMountpoint(env: NodeJS.ProcessEnv): string {
  return (
    env.COCALC_PROJECT_RUNNER_MOUNTPOINT ??
    env.COCALC_FILE_SERVER_MOUNTPOINT ??
    "/mnt/cocalc"
  );
}

function realpathOrSelf(fs: GateFs, path: string): string {
  try {
    return fs.realpathSync(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return posix.resolve(path);
    throw err;
  }
}

function checkProjectReachability(
  fs: GateFs,
  base: string,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  label: string,
): void {
  let real: string;
  try {
    real = fs.realpathSync(base);
  } catch (err) {
    throw new Refuse("records_root_unresolved", `realpath ${base}: ${errCode(err) ?? err}`);
  }
  for (const { kind, path } of projectVisibleRoots(env, dataDir)) {
    let root: string;
    try {
      root = realpathOrSelf(fs, path);
    } catch (err) {
      throw new Refuse(
        "records_root_project_visible",
        `can't resolve the ${kind} root ${path}: ${errCode(err) ?? err}`,
      );
    }
    if (isWithin(real, root)) {
      throw new Refuse(
        "records_root_project_visible",
        `the ${label} ${real} is equal to or below the ${kind} root ${root}`,
      );
    }
  }
  const mountpoint = projectVolumeMountpoint(env);
  let mp: string;
  try {
    mp = realpathOrSelf(fs, mountpoint);
  } catch (err) {
    throw new Refuse(
      "records_root_project_visible",
      `can't resolve the project mountpoint ${mountpoint}: ${errCode(err) ?? err}`,
    );
  }
  if (mp !== real && isWithin(real, mp)) {
    const first = real.slice(mp === "/" ? 1 : mp.length + 1).split("/")[0];
    if (first.startsWith("project-")) {
      throw new Refuse(
        "records_root_project_visible",
        `the ${label} ${real} is in the project volume ${posix.join(mp, first)}`,
      );
    }
  }
}

// A marker copy or the sentinel: a non-symlink regular file, our uid, mode
// exactly 0600, nlink 1 (v8 D3), read without following a link.
type StrictRead =
  | { state: "absent" }
  | { state: "bad"; why: string }
  | { state: "ok"; text: string };

function readStrict(fs: GateFs, path: string, uid: number): StrictRead {
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(path, { bigint: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return { state: "absent" };
    return { state: "bad", why: `lstat ${path}: ${errCode(err) ?? err}` };
  }
  if (st.isSymbolicLink()) return { state: "bad", why: `${path} is a symlink` };
  if (!st.isFile()) return { state: "bad", why: `${path} is not a regular file` };
  if (Number(st.uid) !== uid) {
    return { state: "bad", why: `${path} is owned by uid ${Number(st.uid)}` };
  }
  const mode = Number(st.mode) & 0o7777;
  if (mode !== 0o600) {
    return { state: "bad", why: `${path} has mode ${mode.toString(8)}, not 600` };
  }
  if (st.nlink !== 1n) {
    return { state: "bad", why: `${path} has ${st.nlink} links` };
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
    const fst = fs.fstatSync(fd, { bigint: true });
    if (fst.dev !== st.dev || fst.ino !== st.ino) {
      return { state: "bad", why: `${path} changed while read` };
    }
    const buf = Buffer.alloc(4096);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n >= buf.length) return { state: "bad", why: `${path} is too large` };
    }
    return { state: "ok", text: buf.subarray(0, n).toString("utf8") };
  } catch (err) {
    return { state: "bad", why: `read ${path}: ${errCode(err) ?? err}` };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

interface Marker {
  boot_id: string;
  dev: string;
  ino: string;
  token: string;
}

function parseMarker(text: string): Marker | undefined {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (m == null || typeof m != "object" || Array.isArray(m)) return undefined;
  const keys = Object.keys(m).sort().join(",");
  if (keys !== "boot_id,dev,ino,token,v" || m.v !== 1) return undefined;
  if (!isBootId(m.boot_id)) return undefined;
  if (typeof m.dev != "string" || !DECIMAL_RE.test(m.dev)) return undefined;
  if (typeof m.ino != "string" || !DECIMAL_RE.test(m.ino)) return undefined;
  if (typeof m.token != "string" || !TOKEN_RE.test(m.token)) return undefined;
  return { boot_id: m.boot_id, dev: m.dev, ino: m.ino, token: m.token };
}

function markerText(m: Marker): string {
  return JSON.stringify({ v: 1, boot_id: m.boot_id, dev: m.dev, ino: m.ino, token: m.token });
}

function sameMarker(a: Marker, b: Marker): boolean {
  return (
    a.boot_id === b.boot_id && a.dev === b.dev && a.ino === b.ino && a.token === b.token
  );
}

function fsyncDir(fs: GateFs, dir: string): void {
  const fd = fs.openSync(dir, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Every byte of data to fd: a short write is continued; a write that
// reports no progress (0, or not a positive count within the rest) throws,
// so a truncated file is never fsync'd and renamed (review B1).  The one
// writer of every durable record: the gate's (flag, sentinel, marker B and
// A) and the post-reboot records (persist-durability, ops0's ruling).
export function writeAllSync(
  fs: Pick<GateFs, "writeSync">,
  fd: number,
  data: string,
): void {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!Number.isInteger(n) || n <= 0 || n > buf.length - off) {
      throw Object.assign(
        new Error(`short write: ${n} of ${buf.length - off} bytes`),
        { code: "EIO" },
      );
    }
    off += n;
  }
}

// durably: a new temp file (O_EXCL, no link followed), mode 0600, every
// byte written, fsync, rename, fsync of the directory.  Throws on any
// failure.
function writeDurable(fs: GateFs, dir: string, name: string, data: string): void {
  const tmp = posix.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(
    tmp,
    nodeFs.constants.O_WRONLY |
      nodeFs.constants.O_CREAT |
      nodeFs.constants.O_EXCL |
      nodeFs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      writeAllSync(fs, fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, posix.join(dir, name));
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  fsyncDir(fs, dir);
}

// M1 (v6/v8): at migration only.  The legacy root must be absent, or
// positively empty: a real directory whose record class dirs are each absent
// or a real directory with no entries.  Anything else refuses (records of
// this boot, a link, a non-directory, an enumeration error).
function legacyGate(fs: GateFs, legacy: string): void {
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(legacy, { bigint: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw new Refuse(
      "legacy_records_unreadable",
      `legacy records root ${legacy}: ${errCode(err) ?? err}`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Refuse(
      "legacy_records_unreadable",
      `legacy records root ${legacy} is ${st.isSymbolicLink() ? "a symlink" : "not a directory"}`,
    );
  }
  for (const cls of LEGACY_RECORD_CLASSES) {
    const dir = posix.join(legacy, cls);
    let cst: nodeFs.BigIntStats;
    try {
      cst = fs.lstatSync(dir, { bigint: true });
    } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      throw new Refuse("legacy_records_unreadable", `${dir}: ${errCode(err) ?? err}`);
    }
    if (cst.isSymbolicLink() || !cst.isDirectory()) {
      throw new Refuse(
        "legacy_records_unreadable",
        `${dir} is ${cst.isSymbolicLink() ? "a symlink" : "not a directory"}`,
      );
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      throw new Refuse("legacy_records_unreadable", `${dir}: ${errCode(err) ?? err}`);
    }
    if (names.length > 0) {
      throw new Refuse(
        "legacy_records_present",
        `legacy records present in ${dir}: reboot, or a ruled import`,
      );
    }
  }
}

// Removes a tree without following links; budget.left entries at most.
function removeTree(
  fs: GateFs,
  path: string,
  budget: { left: number },
  errors: string[],
): boolean {
  if (budget.left-- <= 0) return false;
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(path, { bigint: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return true;
    errors.push(`${path}: ${errCode(err) ?? err}`);
    return false;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let names: string[];
    try {
      names = fs.readdirSync(path);
    } catch (err) {
      errors.push(`${path}: ${errCode(err) ?? err}`);
      return false;
    }
    let all = true;
    for (const name of names) {
      if (!removeTree(fs, posix.join(path, name), budget, errors)) all = false;
    }
    if (!all) return false;
    try {
      fs.rmdirSync(path);
    } catch (err) {
      if (errCode(err) === "ENOENT") return true;
      errors.push(`${path}: ${errCode(err) ?? err}`);
      return false;
    }
    return true;
  }
  try {
    fs.unlinkSync(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return true;
    errors.push(`${path}: ${errCode(err) ?? err}`);
    return false;
  }
  return true;
}

// Rule 4: other boots' dirs go; malformed names and non-directories stay
// (reported); a failed delete is counted, never treated as absent.  Never
// fatal: other boots' dirs are ignored by construction.
function prune(
  fs: GateFs,
  recordsDir: string,
  bootId: string,
  out: RecordsGate,
): void {
  const skipped: string[] = [];
  const errors: string[] = [];
  let pruned = 0;
  let names: string[];
  try {
    names = fs.readdirSync(recordsDir);
  } catch (err) {
    errors.push(`${recordsDir}: ${errCode(err) ?? err}`);
    names = [];
  }
  const budget = { left: PRUNE_MAX_ENTRIES };
  for (const name of names) {
    if (name === bootId) continue;
    if (!isBootId(name)) {
      skipped.push(name);
      continue;
    }
    const path = posix.join(recordsDir, name);
    let st: nodeFs.BigIntStats;
    try {
      st = fs.lstatSync(path, { bigint: true });
    } catch (err) {
      if (errCode(err) !== "ENOENT") errors.push(`${path}: ${errCode(err) ?? err}`);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      skipped.push(name);
      continue;
    }
    if (budget.left <= 0) break;
    if (removeTree(fs, path, budget, errors)) pruned += 1;
  }
  out.pruned = pruned;
  out.prune_errors = errors.length;
  out.prune_skipped = skipped.slice(0, 20);
  out.prune_error_detail = errors.slice(0, 5);
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

// The boot dir is new: create it, its sentinel, then marker copy B, then A
// (all durable).  A racing creator (EEXIST) is a re-read.
function createBootDir(
  fs: GateFs,
  recordsDir: string,
  bootDir: string,
  bootId: string,
  base: string,
  stateDir: string,
  uid: number,
  token: string,
): nodeFs.BigIntStats {
  try {
    fs.mkdirSync(bootDir, { mode: 0o700 });
  } catch (err) {
    if (errCode(err) === "EEXIST") {
      throw new Refuse("boot_dir_race", `${bootDir} appeared meanwhile`, true);
    }
    throw new Refuse("records_write_failed", `mkdir ${bootDir}: ${errCode(err) ?? err}`);
  }
  const why = ownPrivateDir(fs, bootDir, uid);
  if (why != null) throw new Refuse("t1_failed", `fail: ${bootDir}: ${why}`);
  let st: nodeFs.BigIntStats;
  try {
    st = fs.lstatSync(bootDir, { bigint: true });
    writeDurable(fs, bootDir, SENTINEL_NAME, JSON.stringify({ v: 1, boot_id: bootId, token }));
    fsyncDir(fs, recordsDir);
    const marker = markerText({
      boot_id: bootId,
      dev: `${st.dev}`,
      ino: `${st.ino}`,
      token,
    });
    writeDurable(fs, stateDir, MARKER_B_NAME, marker);
    writeDurable(fs, base, MARKER_A_NAME, marker);
  } catch (err) {
    throw new Refuse(
      "records_write_failed",
      `setting up ${bootDir}: ${errCode(err) ?? err}`,
    );
  }
  return st;
}

function evaluateOnce(opts: Required<Omit<GateOptions, "stateDir">> & { stateDir?: string }, out: RecordsGate): void {
  const { env, fs, uid } = opts;
  out.overrides = [];
  out.t1 = "not-run";
  delete out.root;
  delete out.root_dev;
  delete out.root_ino;
  delete out.new_boot;
  delete out.migrated;

  // overrides: tests only, and visible
  let testPaths = false;
  if (env[TEST_PATHS_OVERRIDE]) {
    if (env[TEST_PATHS_OVERRIDE] !== "1" || !env.COCALC_TEST_MODE) {
      throw new Refuse(
        "override_refused",
        `${TEST_PATHS_OVERRIDE} is set outside the test mode`,
      );
    }
    testPaths = true;
    out.overrides.push(TEST_PATHS_OVERRIDE);
  }
  if (env[BASE_OVERRIDE]) out.overrides.push(BASE_OVERRIDE);

  const resolved = resolveRecordsBase(env);
  if (resolved == null) {
    throw new Refuse(
      "records_base_unknown",
      "no records base: COCALC_BAY_STATE_DIR (bay) or COCALC_DATA (project host) must be set",
    );
  }
  const { base, role } = resolved;
  out.base = base;
  out.role = role;
  if (!isAbsoluteNormal(base)) {
    throw new Refuse("records_base_invalid", `the records base ${base} is not an absolute normalized path`);
  }

  // 1. the boot id
  let bootId: string;
  try {
    const text = fs.readFileSync(opts.bootIdPath, "utf8");
    bootId = text.endsWith("\n") ? text.slice(0, -1) : text;
  } catch (err) {
    throw new Refuse("boot_id_unreadable", `${opts.bootIdPath}: ${errCode(err) ?? err}`);
  }
  if (!isBootId(bootId)) {
    throw new Refuse("boot_id_invalid", `${opts.bootIdPath} is not a canonical lowercase UUID`);
  }

  const stateDir = opts.stateDir;
  if (stateDir == null || !isAbsoluteNormal(stateDir)) {
    throw new Refuse(
      "state_dir_invalid",
      `the post-reboot state dir (marker copy B) is ${stateDir == null ? "unknown" : `not absolute: ${stateDir}`}`,
    );
  }

  // 2. T1: the base, then copy B's dir
  try {
    t1Walk(fs, base, uid, !testPaths, opts.walkFrom);
    const whyBase = ownPrivateDir(fs, base, uid);
    if (whyBase != null) throw new Refuse("t1_failed", `fail: ${base}: ${whyBase}`);
    t1Walk(fs, stateDir, uid, !testPaths, opts.walkFrom);
  } catch (err) {
    if (err instanceof Refuse) out.t1 = err.message;
    throw err;
  }

  // 3. R-c: not reachable from a project
  if (!testPaths) {
    checkProjectReachability(fs, base, env, opts.dataDir, "records base");
    // the state dir holds marker copy B, with the token (SA 4306 A3)
    checkProjectReachability(fs, stateDir, env, opts.dataDir, "state dir");
  }

  const recordsDir = posix.join(base, RECORDS_DIR_NAME);
  try {
    ensureDir(fs, recordsDir);
  } catch (err) {
    out.t1 = `fail: ${recordsDir}: missing and can't be created (${errCode(err) ?? err})`;
    throw new Refuse("t1_failed", out.t1);
  }
  const whyRecords = ownPrivateDir(fs, recordsDir, uid);
  if (whyRecords != null) {
    out.t1 = `fail: ${recordsDir}: ${whyRecords}`;
    throw new Refuse("t1_failed", out.t1);
  }
  out.t1 = "pass"; // (the boot dir's own check follows)

  // 4. the boot dir and the marker (the TOTAL table, design v8 rule 5)
  const bootDir = posix.join(recordsDir, bootId);
  let bootSt: nodeFs.BigIntStats | undefined;
  try {
    bootSt = fs.lstatSync(bootDir, { bigint: true });
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      throw new Refuse("boot_dir_unreadable", `${bootDir}: ${errCode(err) ?? err}`);
    }
  }
  if (bootSt != null) {
    const why = ownPrivateDir(fs, bootDir, uid);
    if (why != null) {
      out.t1 = `fail: ${bootDir}: ${why}`;
      throw new Refuse("t1_failed", out.t1);
    }
  }
  const pathA = posix.join(base, MARKER_A_NAME);
  const pathB = posix.join(stateDir, MARKER_B_NAME);
  const readA = readStrict(fs, pathA, uid);
  const readB = readStrict(fs, pathB, uid);
  // row 7: unreadable or malformed (either copy)
  for (const [name, r] of [
    ["A", readA],
    ["B", readB],
  ] as const) {
    if (r.state === "bad") throw new Refuse("marker_invalid", `marker copy ${name}: ${r.why}`);
  }
  const markerA = readA.state === "ok" ? parseMarker(readA.text) : undefined;
  const markerB = readB.state === "ok" ? parseMarker(readB.text) : undefined;
  // (written by rename only: never seen half-written)
  if (readA.state === "ok" && markerA == null) {
    throw new Refuse("marker_invalid", `marker copy A (${pathA}) is malformed`);
  }
  if (readB.state === "ok" && markerB == null) {
    throw new Refuse("marker_invalid", `marker copy B (${pathB}) is malformed`);
  }
  // row 6: one copy missing, or the copies differ
  if ((markerA == null) !== (markerB == null)) {
    throw new Refuse(
      "marker_copy_missing",
      `marker copy ${markerA == null ? "A" : "B"} is missing`,
      true,
    );
  }
  if (markerA != null && markerB != null && !sameMarker(markerA, markerB)) {
    throw new Refuse("marker_copies_differ", "the two marker copies differ", true);
  }
  const marker = markerA;

  let rootSt: nodeFs.BigIntStats;
  if (marker == null) {
    // rows 8 and 9: both copies absent
    if (bootSt != null) {
      throw new Refuse(
        "marker_missing",
        `both marker copies are missing but ${bootDir} exists`,
        true,
      );
    }
    const flagPath = posix.join(stateDir, MIGRATION_FLAG_NAME);
    try {
      fs.lstatSync(flagPath, { bigint: true });
      throw new Refuse(
        "marker_missing",
        "both marker copies are missing after the migration (records_root_replaced?)",
        true,
      );
    } catch (err) {
      if (err instanceof Refuse) throw err;
      if (errCode(err) !== "ENOENT") {
        throw new Refuse("migration_flag_unreadable", `${flagPath}: ${errCode(err) ?? err}`);
      }
    }
    // the first start of this code on this host: the legacy gate, then the
    // one-time flag (durably), then a new boot dir
    legacyGate(fs, legacyRunDir(env));
    try {
      writeDurable(
        fs,
        stateDir,
        MIGRATION_FLAG_NAME,
        JSON.stringify({ v: 1, boot_id: bootId, migrated: Date.now() }),
      );
    } catch (err) {
      throw new Refuse("records_write_failed", `migration flag ${flagPath}: ${errCode(err) ?? err}`);
    }
    rootSt = createBootDir(fs, recordsDir, bootDir, bootId, base, stateDir, uid, opts.token());
    out.migrated = true;
    out.new_boot = true;
  } else if (marker.boot_id !== bootId) {
    // rows 1 and 2: the marker is of another boot
    if (bootSt != null) {
      throw new Refuse(
        "boot_dir_unexpected",
        `${bootDir} exists but the marker is of another boot`,
        true,
      );
    }
    rootSt = createBootDir(fs, recordsDir, bootDir, bootId, base, stateDir, uid, opts.token());
    out.new_boot = true;
  } else {
    // rows 3-5: the marker is of this boot
    if (bootSt == null) {
      throw new Refuse(
        "records_root_replaced",
        `${bootDir} is missing although the marker is of this boot`,
      );
    }
    if (`${bootSt.dev}` !== marker.dev || `${bootSt.ino}` !== marker.ino) {
      throw new Refuse(
        "records_root_replaced",
        `${bootDir} is not the directory the marker names (dev/ino changed)`,
      );
    }
    // (the sentinel is written before either marker copy: never transient)
    const sentinel = readStrict(fs, posix.join(bootDir, SENTINEL_NAME), uid);
    if (sentinel.state === "absent") {
      throw new Refuse("records_root_replaced", `the sentinel in ${bootDir} is missing`);
    }
    if (sentinel.state === "bad") {
      throw new Refuse("records_root_replaced", `the sentinel: ${sentinel.why}`);
    }
    let s: any;
    try {
      s = JSON.parse(sentinel.text);
    } catch {
      s = undefined;
    }
    if (s?.token !== marker.token || s?.boot_id !== bootId) {
      throw new Refuse("records_root_replaced", `the sentinel in ${bootDir} does not match the marker`);
    }
    rootSt = bootSt;
  }

  out.root = bootDir;
  out.root_dev = `${rootSt.dev}`;
  out.root_ino = `${rootSt.ino}`;

  // 6. other boots
  prune(fs, recordsDir, bootId, out);
}

// The gate.  Never throws: any failure is a refusal.
export function evaluateRecordsGate(options: GateOptions = {}): RecordsGate {
  const opts = {
    env: options.env ?? process.env,
    fs: options.fs ?? (nodeFs as unknown as GateFs),
    uid: options.uid ?? process.getuid?.() ?? -1,
    bootIdPath: options.bootIdPath ?? BOOT_ID_PATH,
    stateDir: options.stateDir,
    dataDir: options.dataDir ?? "/nonexistent-data-dir",
    token: options.token ?? newToken,
    retries: options.retries ?? GATE_RETRIES,
    retryMs: options.retryMs ?? GATE_RETRY_MS,
    sleep: options.sleep ?? sleepSync,
    walkFrom: options.walkFrom ?? "/",
  };
  const out: RecordsGate = { ok: false, t1: "not-run", overrides: [] };
  for (let attempt = 0; ; attempt++) {
    try {
      evaluateOnce(opts, out);
      out.ok = true;
      delete out.code;
      delete out.reason;
      return out;
    } catch (err) {
      const transient = err instanceof Refuse && err.transient;
      if (transient && attempt < opts.retries) {
        try {
          opts.sleep(opts.retryMs);
        } catch {}
        continue;
      }
      out.ok = false;
      out.code = err instanceof Refuse ? err.code : "records_gate_error";
      out.reason = err instanceof Error ? err.message : `${err}`;
      delete out.root;
      delete out.root_dev;
      delete out.root_ino;
      return out;
    }
  }
}
