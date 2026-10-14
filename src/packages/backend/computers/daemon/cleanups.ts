/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Durable cleanup of processes a previous daemon left running (an exec in
// flight when it died). Each record is a file; drive() re-drives it on every
// tick, across restarts, until its verified group leader is gone: SIGTERM,
// then SIGKILL after the grace period (wall clock or this boot's clock).

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isValidUUID } from "@cocalc/util/misc";
import { systemBootClock, type BootClock } from "./clock";
import { ensurePrivateDir, readJson, writeDurableJson } from "./durable";
import { leaderAlive, signalVerifiedGroup } from "./launch";

interface CleanupRecord {
  id: string;
  pid: number;
  pid_start: string;
  term_at: number | null;
  term_boot: { boot_id: string; since_boot_ms: number } | null;
}

export class Cleanups {
  private readonly dir: string;

  constructor(
    stateDir: string,
    private readonly graceMs: number,
    private readonly bootClock: BootClock = systemBootClock,
  ) {
    this.dir = join(stateDir, "cleanup");
    ensurePrivateDir(this.dir);
  }

  private path(id: string): string {
    if (!isValidUUID(id)) throw new Error("bad cleanup id");
    return join(this.dir, `${id}.json`);
  }

  add(id: string, pid: number, pid_start: string): void {
    if (readJson(this.path(id)) != null) return;
    writeDurableJson(this.path(id), {
      id,
      pid,
      pid_start,
      term_at: null,
      term_boot: null,
    } satisfies CleanupRecord);
  }

  pending(): CleanupRecord[] {
    const records: CleanupRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const r = readJson<CleanupRecord>(join(this.dir, name));
      if (r != null) records.push(r);
    }
    return records;
  }

  drive(now = Date.now()): void {
    for (const r of this.pending()) {
      if (!leaderAlive(r.pid, r.pid_start)) {
        rmSync(this.path(r.id), { force: true });
        continue;
      }
      if (r.term_at == null) {
        const boot_id = this.bootClock.bootId();
        const since = this.bootClock.sinceBootMs();
        writeDurableJson(this.path(r.id), {
          ...r,
          term_at: now,
          term_boot:
            boot_id != null && since != null
              ? { boot_id, since_boot_ms: since }
              : null,
        } satisfies CleanupRecord);
        signalVerifiedGroup(r.pid, r.pid_start, "SIGTERM");
        continue;
      }
      let over = now - r.term_at >= this.graceMs;
      const boot = r.term_boot;
      if (!over && boot != null && boot.boot_id === this.bootClock.bootId()) {
        const since = this.bootClock.sinceBootMs();
        over = since != null && since - boot.since_boot_ms >= this.graceMs;
      }
      if (over) signalVerifiedGroup(r.pid, r.pid_start, "SIGKILL");
    }
  }
}
