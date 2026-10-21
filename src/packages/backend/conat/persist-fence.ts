/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The parts of persist fences (conat/persist/fence.ts) that need this host:

- who holds a fence: a process on this host, by pid and start time;
- the store where a fence service keeps the fences it holds, so it holds
  them again after a restart;
- the capability file a fence service writes once it serves, so that a
  holder can tell a persist server that has fences, whose service may be
  briefly unreachable (then it must not go ahead unfenced), from one from
  before fences (then it may).
*/

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PersistFenceHolder,
  PersistFenceRecord,
  PersistFenceStore,
} from "@cocalc/conat/persist/fence";
import { isValidUUID } from "@cocalc/util/misc";

const CAPABILITY_FILE = "capability.json";
const INSTANCES_FILE = "instances.json";
// A replacement's instance is kept this long: longer than any client stays
// away and then resumes the project's streams.
const INSTANCE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// Linux reports process start times in these clock ticks (USER_HZ), 100 on
// every architecture it runs on.
const CLOCK_TICKS_PER_SECOND = 100;

// The fields of /proc/<pid>/stat after the command name (field 2, which may
// contain spaces): [2] is the process group, [19] the start time.  "gone" if
// there is no such process; "unknown" if it can't be told.
type Stat = string[] | "gone" | "unknown";

function processStat(pid: number | "self"): Stat {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields.length > 19 ? fields : "unknown";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") return "unknown";
    // without /proc, nothing is known from it
    return Array.isArray(processStat("self")) ? "gone" : "unknown";
  }
}

export function currentFenceHolder(): PersistFenceHolder {
  const stat = processStat("self");
  const pgid = Array.isArray(stat) ? Number(stat[2]) : NaN;
  return {
    pid: process.pid,
    start: Array.isArray(stat) ? stat[19] : "",
    ...(Number.isSafeInteger(pgid) && pgid > 0 ? { pgid } : {}),
  };
}

// When this host booted (ms), from how long it has been up.
function bootTimeMs(): number | undefined {
  try {
    const uptime = parseFloat(readFileSync("/proc/uptime", "utf8"));
    return Number.isFinite(uptime) ? Date.now() - uptime * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// Whether some process of group pgid that started at since (ms) or later
// runs.  It errs toward yes: a second before since counts, and so does
// anything it can't tell.
export function processGroupRunsSince(pgid: number, since: number): boolean {
  const boot = bootTimeMs();
  if (boot == null) return true;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const stat = processStat(Number(name));
    if (stat === "gone") continue;
    if (stat === "unknown") return true;
    if (Number(stat[2]) !== pgid) continue;
    const started = boot + (Number(stat[19]) / CLOCK_TICKS_PER_SECOND) * 1000;
    if (!(started < since - 1000)) return true;
  }
  return false;
}

// Whether holder, or anything it started to change the files since the
// fence was taken (at since), may still run: the holder process itself (not
// another one that got its pid), or a process of its group that started
// since then (e.g., rustic, or sudo waiting for a helper, which can outlive
// the holder).  Older processes of the group (e.g., servers it started
// before) don't count.  Only what is known to be gone is gone: anything that
// can't be told counts as running.
export function isFenceHolderAlive(
  holder: PersistFenceHolder,
  since: number = Date.now(),
): boolean {
  if (isProcessAlive(holder)) return true;
  const { pgid } = holder;
  return (
    pgid != null &&
    Number.isSafeInteger(pgid) &&
    pgid > 1 &&
    processGroupRunsSince(pgid, since)
  );
}

// Whether the holder process itself may still run: the same process, not
// another one that got its pid.
function isProcessAlive({ pid, start }: PersistFenceHolder): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const stat = processStat(pid);
  if (Array.isArray(stat)) return start === "" || stat[19] === start;
  if (stat === "gone") return false;
  // /proc can't tell: only whether some process has that pid
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

// undefined if there is no such file; anything else that keeps it from being
// read is an error: these files hold fences, and losing one silently would
// let clients in while files may be changing.
function readJson(path: string): any {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`persist fence store: ${path} is not valid JSON: ${err}`);
  }
}

// One file per fenced project in dir, which only the host can reach, and one
// with the instances of projects whose files were replaced.
export function fileFenceStore(
  dir: string,
  { now = Date.now }: { now?: () => number } = {},
): PersistFenceStore {
  const instancesPath = join(dir, INSTANCES_FILE);
  // project_id -> { instance, time }
  const readInstances = (): {
    [project_id: string]: { instance: string; time: number };
  } => {
    const data = readJson(instancesPath);
    if (data != null && (typeof data != "object" || Array.isArray(data))) {
      throw new Error(`persist fence store: ${instancesPath} is malformed`);
    }
    const instances = {};
    for (const [project_id, value] of Object.entries(data ?? {})) {
      const { instance, time } = (value ?? {}) as any;
      if (
        !isValidUUID(project_id) ||
        typeof instance != "string" ||
        !instance ||
        !Number.isFinite(time)
      ) {
        throw new Error(
          `persist fence store: ${instancesPath} has a malformed entry for ${project_id}`,
        );
      }
      if (now() - time < INSTANCE_RETENTION_MS) {
        instances[project_id] = { instance, time };
      }
    }
    return instances;
  };
  const file = (project_id: string) => {
    if (!isValidUUID(project_id)) {
      throw new Error(`invalid project id: ${project_id}`);
    }
    return join(dir, `${project_id}.json`);
  };
  return {
    load: () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const records: PersistFenceRecord[] = [];
      for (const name of readdirSync(dir)) {
        const project_id = name.match(/^(.+)\.json$/)?.[1];
        if (project_id == null || !isValidUUID(project_id)) continue;
        const record = readJson(join(dir, name));
        if (record == null) continue;
        if (
          record.project_id !== project_id ||
          typeof record.token != "string" ||
          !Number.isSafeInteger(record.holder?.pid) ||
          typeof record.holder?.start != "string" ||
          !Number.isFinite(record.since)
        ) {
          // kept for an operator: it is a fence that can't be honored
          throw new Error(
            `persist fence store: ${join(dir, name)} is malformed`,
          );
        }
        const pgid = record.holder.pgid;
        records.push({
          project_id,
          token: record.token,
          holder: {
            pid: record.holder.pid,
            start: record.holder.start,
            ...(Number.isSafeInteger(pgid) ? { pgid } : {}),
          },
          since: record.since,
        });
      }
      return records;
    },
    save: (record) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJson(file(record.project_id), record);
    },
    remove: (project_id, token) => {
      const path = file(project_id);
      if (readJson(path)?.token === token) {
        rmSync(path, { force: true });
      }
    },
    loadInstances: () => {
      const instances = {};
      for (const [project_id, { instance }] of Object.entries(
        readInstances(),
      )) {
        instances[project_id] = instance;
      }
      return instances;
    },
    // throws if it can't be saved, so the fence is not released
    saveInstance: (project_id, instance) => {
      if (!isValidUUID(project_id)) {
        throw new Error(`invalid project id: ${project_id}`);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJson(instancesPath, {
        ...readInstances(),
        [project_id]: { instance, time: now() },
      });
    },
  };
}

// Written by a fence service once it serves (removed when it stops).
export function writeFenceCapability(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(join(dir, CAPABILITY_FILE), { holder: currentFenceHolder() });
}

export function removeFenceCapability(dir: string): void {
  const path = join(dir, CAPABILITY_FILE);
  try {
    if (readJson(path)?.holder?.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch {
    // stopping anyway; a stale file names a process that is gone
  }
}

// Whether a persist server with a fence service runs on this host: its
// capability file names a process that still runs.  A file that can't be
// read counts as yes (then a restore waits rather than go ahead unfenced).
export function fenceCapableServerRunning(dir: string): boolean {
  let holder;
  try {
    holder = readJson(join(dir, CAPABILITY_FILE))?.holder;
  } catch {
    return true;
  }
  return (
    holder != null &&
    Number.isSafeInteger(holder.pid) &&
    typeof holder.start == "string" &&
    isProcessAlive(holder)
  );
}
