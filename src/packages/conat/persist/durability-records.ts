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
  created: number;
}

export type DurabilityRecords = PersistDurabilityRecords & {
  generation: string;
  root: string;
  dirtyPath: (id: string) => string;
  poisonedPath: (id: string) => string;
};

export function createDurabilityRecords({
  root,
  generation,
  fs,
  sha256,
  pid = 0,
  warn = () => {},
}: {
  root: string;
  generation: string;
  fs: DurabilityFs;
  sha256: (data: string) => string;
  pid?: number;
  warn?: (message: string, err: unknown) => void;
}): DurabilityRecords {
  const dirtyDir = posix.join(root, "dirty");
  const poisonedDir = posix.join(root, "poisoned-file");
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
    },

    check: (id: string): PersistDurabilityCheck => {
      if (exists(poisonedPath(id))) return "poisoned";
      let names: string[];
      try {
        names = fs.readdirSync(dirtyKeyDir(id));
      } catch (err) {
        if ((err as any)?.code === "ENOENT") return "ok";
        return "unverified"; // can't tell: fail closed
      }
      for (const name of names) {
        // a record still being written: its operation had not started
        if (name.endsWith(".tmp")) continue;
        // ours: this process armed it and saw no sync error (or it would be
        // poisoned), e.g., an open that failed after arming
        if (name === generation) continue;
        // another process's: it crashed mid-write, or is writing the file
        // now; either way this process can't vouch for the page cache
        return "unverified";
      }
      return "ok";
    },
  };
}
