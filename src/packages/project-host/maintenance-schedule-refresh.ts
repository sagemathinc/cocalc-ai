/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";

type Row = HostProjectMaintenanceSchedule;
interface Observation {
  row: Row | undefined;
  version: number;
  at: number;
}

const REFRESH_INTERVAL_MS = 60_000;
// The owner-host inventory API accepts at most 100 targeted project ids.
const REFRESH_BATCH_LIMIT = 100;

// A shared, best-effort freshness budget, not an authorization cache. Dispatch
// must still confirm assignment and generation before mutating project data.
export class MaintenanceScheduleRefresh {
  private readonly observations = new Map<string, Observation>();
  private fullInventoryVersion = 0;
  private lastAttemptAt = -Infinity;
  private flight: Promise<void> | undefined;

  observe({
    rows,
    version,
    at,
    projectIds,
  }: {
    rows: Row[];
    version: number;
    at: number;
    projectIds?: string[];
  }): void {
    if (version < this.fullInventoryVersion) return;
    if (!projectIds) this.fullInventoryVersion = version;
    const byId = new Map(rows.map((row) => [row.project_id, row]));
    const ids =
      projectIds ?? new Set([...this.observations.keys(), ...byId.keys()]);
    for (const id of ids) {
      const previous = this.observations.get(id);
      if (!previous || previous.version <= version) {
        // Full inventories bound cache retention to the host's current rows.
        // Targeted misses retain a versioned tombstone until that inventory.
        if (!projectIds && !byId.has(id)) {
          this.observations.delete(id);
          continue;
        }
        this.observations.set(id, { row: byId.get(id), version, at });
      }
    }
  }

  async get({
    row,
    pendingProjectIds,
    list,
    onError,
    fresh: requireFresh = false,
  }: {
    row: Row;
    pendingProjectIds: () => string[];
    list: (projectIds: string[]) => Promise<Row[]>;
    onError: (err: unknown) => void;
    /** Re-read this row even inside the shared refresh budget. */
    fresh?: boolean;
  }): Promise<Row | undefined> {
    const current = () => {
      return this.observations.get(row.project_id)?.row;
    };
    const now = Date.now();
    const observed = this.observations.get(row.project_id);
    if (!observed?.row) return undefined;
    if (requireFresh) {
      // Every cached observation (and any refresh already in flight) may
      // predate the caller's reason for needing a fresh row, so read it alone.
      try {
        const rows = await list([row.project_id]);
        if (this.observations.get(row.project_id) === observed) {
          this.observations.set(row.project_id, {
            row: rows.find(
              (candidate) => candidate.project_id === row.project_id,
            ),
            version: observed.version,
            at: Date.now(),
          });
        }
        return current();
      } catch (err) {
        // A stale row would repeat work that just finished; skip, and let the
        // next inventory decide.
        onError(err);
        return undefined;
      }
    }
    if (observed && now - observed.at < REFRESH_INTERVAL_MS) return current();
    if (this.flight) {
      await this.flight;
      return current();
    }
    // Uncached work inside this window uses its existing inventory and the
    // mandatory assignment check, rather than issuing another per-row RPC.
    if (now - this.lastAttemptAt < REFRESH_INTERVAL_MS) return current();
    const ids = new Set([row.project_id]);
    for (const id of pendingProjectIds()) {
      if (ids.size >= REFRESH_BATCH_LIMIT) break;
      const pending = this.observations.get(id);
      if (pending?.row && now - pending.at >= REFRESH_INTERVAL_MS) ids.add(id);
    }
    const before = new Map(
      [...ids].map((id) => [id, this.observations.get(id)]),
    );
    this.lastAttemptAt = now;
    this.flight = (async () => {
      try {
        const rows = await list([...ids]);
        const fresh = new Map(
          rows.map((candidate) => [candidate.project_id, candidate]),
        );
        for (const id of ids) {
          const previous = before.get(id);
          // An overlapping event/full inventory is newer than this refresh.
          if (this.observations.get(id) !== previous) continue;
          this.observations.set(id, {
            row: fresh.get(id),
            version: previous?.version ?? 0,
            at: now,
          });
        }
      } catch (err) {
        // Failed attempts also consume the budget during a bay outage.
        onError(err);
      }
    })();
    try {
      await this.flight;
      return current();
    } finally {
      this.flight = undefined;
    }
  }
}
