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

// The start time of process pid (field 22 of /proc/<pid>/stat), if readable.
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // the command name (field 2) may contain spaces; fields after it don't
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
  } catch {
    return undefined;
  }
}

export function currentFenceHolder(): PersistFenceHolder {
  return { pid: process.pid, start: processStartTime(process.pid) ?? "" };
}

// Whether holder still runs: the same process, not another one that got its
// pid.
export function isFenceHolderAlive({
  pid,
  start,
}: PersistFenceHolder): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const current = processStartTime(pid);
  if (current != null) return current === start;
  // no /proc: only whether some process has that pid
  try {
    process.kill(pid, 0);
    return start === "";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" && start === "";
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
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
    const instances = {};
    for (const [project_id, value] of Object.entries(data ?? {})) {
      const { instance, time } = (value ?? {}) as any;
      if (
        isValidUUID(project_id) &&
        typeof instance == "string" &&
        instance &&
        Number.isFinite(time) &&
        now() - time < INSTANCE_RETENTION_MS
      ) {
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
        if (
          record?.project_id === project_id &&
          typeof record.token == "string" &&
          Number.isSafeInteger(record.holder?.pid) &&
          typeof record.holder?.start == "string"
        ) {
          records.push({
            project_id,
            token: record.token,
            holder: { pid: record.holder.pid, start: record.holder.start },
            since: Number(record.since) || Date.now(),
          });
        } else {
          rmSync(join(dir, name), { force: true });
        }
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
  const holder = readJson(path)?.holder;
  if (holder?.pid === process.pid) {
    rmSync(path, { force: true });
  }
}

// Whether a persist server with a fence service runs on this host: its
// capability file names a process that still runs.
export function fenceCapableServerRunning(dir: string): boolean {
  const holder = readJson(join(dir, CAPABILITY_FILE))?.holder;
  return (
    holder != null &&
    Number.isSafeInteger(holder.pid) &&
    typeof holder.start == "string" &&
    isFenceHolderAlive(holder)
  );
}
