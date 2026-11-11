/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durability records of disk-backed persist streams (finding 028, DESIGN
// §3.2.5-§3.2.6), on tmpfs, so they survive a persist restart and vanish at
// reboot, together with the page cache they are about.
//
//   <root>/dirty/<key>          created before an operation that can consume
//                               a sync error, removed at the next write idle
//   <root>/poisoned-file/<key>  the dirty record, renamed when a sync error
//                               was returned
//
// key = sha256 of the stream's logical id (its normalized path, never a
// resolved one: a user who can swap a symlink must not wash a record off).
// A record holds the generation of the process that wrote it, so a dirty
// record left by another process (a crash mid-write) is told apart from this
// process's own.  Every write is a temp file plus rename, never fsync'd: the
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
  renameSync: (from: string, to: string) => void;
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
  const dirtyPath = (id: string) => posix.join(dirtyDir, sha256(id));
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
      writeAtomically(dirtyPath(id), JSON.stringify(record));
    },

    disarm: (id: string): void => {
      try {
        fs.unlinkSync(dirtyPath(id));
      } catch (err) {
        if ((err as any)?.code === "ENOENT") return;
        // a record that stays only costs a verified open later
        warn("could not remove a dirty record", err);
      }
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
      let data: string;
      try {
        data = fs.readFileSync(dirtyPath(id), "utf8");
      } catch (err) {
        if ((err as any)?.code === "ENOENT") return "ok";
        return "unverified"; // can't tell: fail closed
      }
      try {
        const record = JSON.parse(data) as DirtyRecord;
        // ours: this process armed it and saw no sync error (or it would be
        // poisoned), e.g., an open that failed after arming
        if (record?.generation === generation) return "ok";
      } catch {}
      return "unverified";
    },
  };
}
