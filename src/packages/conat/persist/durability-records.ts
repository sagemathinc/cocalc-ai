/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durability records of disk-backed persist streams (finding 028, DESIGN
// §3.2.5-§3.2.6), on tmpfs, so they survive a persist restart and vanish at
// reboot, together with the page cache they are about.
//
//   <root>/dirty/<key>/<generation>  created by a process before an
//                               operation that can consume a sync error,
//                               removed at its next write idle
//   <root>/poisoned-file/<key>  that process's dirty record, renamed when a
//                               sync error was returned
//   <root>/poisoned-project/<owner>  a quota error returned by an fsync of
//                               ours on a project path (Q-F, §3.2.3): every
//                               stream of that project is refused (B-2)
//
// Plus the SECONDARY, post-reboot record (B-2, §3.2.5 (b)), on a persistent
// state directory (never the stream's own directory), written durably:
//   <state>/poisoned/<key>      after a reboot (the tmpfs records are gone,
//                               and with them the page cache) the stream is
//                               opened only after a full integrity_check.
// Failing to write it is not fatal: it is retried, with an alert.
//
// key = sha256 of the stream's logical id (its normalized path, never a
// resolved one: a user who can swap a symlink must not wash a record off).
// Each process has its own dirty record per key (named by its generation),
// so no process removes another's, and a dirty record of another process (a
// crash mid-write, or another process writing the same file now) is told
// apart from this process's own.  Every write is a temp file plus rename, never fsync'd: the
// record only has to outlive the process, not the boot.
//
// The file system is passed in (the backend passes node:fs), since this
// package is also bundled for the browser.

import { posix } from "path";
import type {
  PersistDurabilityCheck,
  PersistDurabilityRecords,
} from "./context";

export interface DurabilityFs {
  mkdirSync: (path: string, opts: { recursive: true; mode: number }) => any;
  readFileSync: (path: string, encoding: "utf8") => string;
  readdirSync: (path: string) => string[];
  renameSync: (from: string, to: string) => void;
  rmdirSync: (path: string) => void;
  unlinkSync: (path: string) => void;
  writeFileSync: (path: string, data: string, opts: { mode: number }) => void;
}

interface DirtyRecord {
  kind: "dirty";
  generation: string;
  pid: number;
  // the process's start time (Linux: /proc/<pid>/stat field 22), so a reused
  // pid is not mistaken for the writer (B-2)
  procStart?: string;
  created: number;
}

export type DurabilityRecords = PersistDurabilityRecords & {
  generation: string;
  root: string;
  dirtyPath: (id: string) => string;
  poisonedPath: (id: string) => string;
  // (b) records not written yet (retried by the caller's timer)
  retryPostReboot: () => number;
  postRebootPending: () => number;
};

// The secondary, durable, post-reboot record store (§3.2.5 (b)), by key.
// write/remove are durable (fsync of the file and its directory) and throw on
// failure; exists fails closed (anything but "absent" is present).
export interface PostRebootRecords {
  write: (key: string, data: string) => void;
  exists: (key: string) => boolean;
  remove: (key: string) => void;
}

// Whether the process that wrote a dirty record still runs.  Anything but a
// definite "no" counts as alive (fail closed: its record keeps refusing).
export type IsWriterAlive = (pid: number, procStart?: string) => boolean;

export function createDurabilityRecords({
  root,
  generation,
  fs,
  sha256,
  pid = 0,
  procStart,
  isWriterAlive = () => true,
  postReboot,
  warn = () => {},
}: {
  root: string;
  generation: string;
  fs: DurabilityFs;
  sha256: (data: string) => string;
  pid?: number;
  procStart?: string;
  isWriterAlive?: IsWriterAlive;
  postReboot?: PostRebootRecords;
  warn?: (message: string, err: unknown) => void;
}): DurabilityRecords {
  // (b) records whose write failed: key -> data, retried
  const pendingPostReboot = new Map<string, string>();
  const writePostReboot = (key: string, data: string): boolean => {
    if (postReboot == null) return true;
    try {
      postReboot.write(key, data);
      pendingPostReboot.delete(key);
      return true;
    } catch (err) {
      pendingPostReboot.set(key, data);
      warn(
        "persist alert (non-paging): could not write a post-reboot poison record; retrying (finding 028)",
        err,
      );
      return false;
    }
  };
  const dirtyDir = posix.join(root, "dirty");
  const poisonedDir = posix.join(root, "poisoned-file");
  const poisonedProjectDir = posix.join(root, "poisoned-project");
  // owners are project ids (or "host"): never a path component otherwise
  const safeOwner = (owner: string): string | undefined =>
    /^[0-9a-zA-Z-]{1,64}$/.test(owner) && owner !== "host" ? owner : undefined;
  let ready = false;
  const ensureDirs = () => {
    if (ready) return;
    fs.mkdirSync(dirtyDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(poisonedDir, { recursive: true, mode: 0o700 });
    ready = true;
  };
  // this process's dirty record for id
  const dirtyKeyDir = (id: string) => posix.join(dirtyDir, sha256(id));
  const dirtyPath = (id: string) => posix.join(dirtyKeyDir(id), generation);
  const poisonedPath = (id: string) => posix.join(poisonedDir, sha256(id));
  // atomic: a reader sees the old record or the new one, never a part
  const writeAtomically = (path: string, data: string) => {
    const tmp = `${path}.${generation}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, path);
  };
  // anything but "absent" counts as present: fail closed
  const exists = (path: string): boolean => {
    try {
      fs.readFileSync(path, "utf8");
      return true;
    } catch (err) {
      return (err as any)?.code !== "ENOENT";
    }
  };

  // whether the writer of another generation's dirty record still runs
  const otherAlive = (id: string, name: string): boolean => {
    let record: Partial<DirtyRecord>;
    try {
      record = JSON.parse(
        fs.readFileSync(posix.join(dirtyKeyDir(id), name), "utf8"),
      );
    } catch {
      return true; // unreadable: fail closed
    }
    const recordPid = Number(record?.pid);
    if (!Number.isInteger(recordPid) || recordPid <= 0) return true;
    try {
      return isWriterAlive(recordPid, record?.procStart);
    } catch {
      return true;
    }
  };

  return {
    generation,
    root,
    dirtyPath,
    poisonedPath,

    arm: (id: string): void => {
      ensureDirs();
      const record: DirtyRecord = {
        kind: "dirty",
        generation,
        pid,
        procStart,
        created: Date.now(),
      };
      const write = () => {
        fs.mkdirSync(dirtyKeyDir(id), { recursive: true, mode: 0o700 });
        writeAtomically(dirtyPath(id), JSON.stringify(record));
      };
      try {
        write();
      } catch (err) {
        // another process's disarm removed the (then empty) key directory
        // between our mkdir and our write: once more (#139 N-2)
        if ((err as any)?.code !== "ENOENT") throw err;
        write();
      }
    },

    disarm: (id: string): void => {
      try {
        fs.unlinkSync(dirtyPath(id));
      } catch (err) {
        if ((err as any)?.code !== "ENOENT") {
          // a record that stays only costs a verified open later
          warn("could not remove a dirty record", err);
          return;
        }
      }
      try {
        // fails while another process has a record for id: fine
        fs.rmdirSync(dirtyKeyDir(id));
      } catch {}
    },

    poison: (id: string, info: Record<string, string | number>): void => {
      const target = poisonedPath(id);
      try {
        ensureDirs();
        try {
          // the record that already existed before the failing operation
          fs.renameSync(dirtyPath(id), target);
        } catch (err) {
          if ((err as any)?.code !== "ENOENT") throw err;
        }
        writeAtomically(
          target,
          JSON.stringify({
            kind: "poisoned-file",
            generation,
            pid,
            poisoned: Date.now(),
            ...info,
          }),
        );
      } catch (err) {
        // the dirty record (if the rename failed) refuses just the same after
        // a restart, and this process keeps the file poisoned in memory
        warn("could not write a poisoned-file record", err);
      }
      // (b): survives a reboot; never fatal (§3.2.5 (b))
      writePostReboot(
        sha256(id),
        JSON.stringify({ kind: "poisoned", id, poisoned: Date.now(), ...info }),
      );
    },

    poisonProject: (owner: string, info: Record<string, string | number>) => {
      const name = safeOwner(owner);
      if (name == null) return;
      try {
        fs.mkdirSync(poisonedProjectDir, { recursive: true, mode: 0o700 });
        writeAtomically(
          posix.join(poisonedProjectDir, name),
          JSON.stringify({
            kind: "poisoned-project",
            owner: name,
            generation,
            pid,
            poisoned: Date.now(),
            ...info,
          }),
        );
      } catch (err) {
        warn("could not write a poisoned-project record", err);
      }
    },

    retryPostReboot: (): number => {
      for (const [key, data] of [...pendingPostReboot]) {
        writePostReboot(key, data);
      }
      return pendingPostReboot.size;
    },

    postRebootPending: (): number => pendingPostReboot.size,

    clearPostReboot: (id: string): void => {
      postReboot?.remove(sha256(id));
    },

    check: (id: string, owner?: string): PersistDurabilityCheck => {
      if (exists(poisonedPath(id))) return "poisoned";
      const name = owner == null ? undefined : safeOwner(owner);
      if (name != null && exists(posix.join(poisonedProjectDir, name))) {
        return "poisoned";
      }
      // poisoned in an earlier boot: a full integrity_check first (§3.2.6)
      if (postReboot != null) {
        let present = true;
        try {
          present = postReboot.exists(sha256(id));
        } catch {}
        if (present) return "needs-check";
      }
      let names: string[];
      try {
        names = fs.readdirSync(dirtyKeyDir(id));
      } catch (err) {
        if ((err as any)?.code === "ENOENT") return "ok";
        return "unverified"; // can't tell: fail closed
      }
      let leftover = false;
      for (const name of names) {
        // a record still being written: its operation had not started
        if (name.endsWith(".tmp")) continue;
        // ours: this process armed it and saw no sync error (or it would be
        // poisoned), e.g., an open that failed after arming
        if (name === generation) continue;
        // another process's: if it still runs, it may be writing the file
        // now and this process can't vouch for the page cache; if it is
        // gone, it crashed mid-write and the outcome is unknown, which a
        // verified eviction settles (B-2, §3.2.6 H-b)
        if (otherAlive(id, name)) return "unverified";
        leftover = true;
      }
      return leftover ? "leftover" : "ok";
    },

    // After a verified eviction: the records of dead generations go (never a
    // live process's).  Returns how many were removed.
    clearLeftovers: (id: string): number => {
      let names: string[];
      try {
        names = fs.readdirSync(dirtyKeyDir(id));
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (name.endsWith(".tmp") || name === generation) continue;
        if (otherAlive(id, name)) continue;
        try {
          fs.unlinkSync(posix.join(dirtyKeyDir(id), name));
          removed += 1;
        } catch (err) {
          if ((err as any)?.code !== "ENOENT") {
            warn("could not remove a leftover dirty record", err);
          }
        }
      }
      try {
        fs.rmdirSync(dirtyKeyDir(id));
      } catch {}
      return removed;
    },
  };
}
