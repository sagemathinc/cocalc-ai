/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  decideSnapshotPrune,
  DEFAULT_MAX_PRUNE_DEFERRAL_MS,
  getSnapshotPruneGateStats,
  maxPruneDeferralMs,
  notePendingPrune,
  clearPendingPrune,
  resetSnapshotPruneGateForTest,
  retryDeferredPrunes,
} from "./snapshot-prune-gate";

const MIN = 60_000;

beforeEach(() => resetSnapshotPruneGateForTest());

describe("decideSnapshotPrune", () => {
  it("allows a prune on an idle host", () => {
    expect(
      decideSnapshotPrune({
        projectId: "p",
        backupsInFlight: 0,
        lifecycleActive: 0,
        now: 0,
      }),
    ).toEqual({ allow: true, reason: "idle", deferredForMs: 0 });
  });

  it("defers while a backup runs or a project starts or stops", () => {
    expect(
      decideSnapshotPrune({
        projectId: "a",
        backupsInFlight: 1,
        lifecycleActive: 0,
        now: 0,
      }),
    ).toMatchObject({ allow: false, reason: "backup_running" });
    expect(
      decideSnapshotPrune({
        projectId: "b",
        backupsInFlight: 0,
        lifecycleActive: 2,
        now: 0,
      }),
    ).toMatchObject({ allow: false, reason: "lifecycle_active" });
    expect(getSnapshotPruneGateStats()).toEqual({
      deferred: 2,
      forced: 0,
      pending_projects: 0,
    });
  });

  it("prunes anyway once a project has waited the full bound", () => {
    const busy = { projectId: "p", backupsInFlight: 3, lifecycleActive: 1 };
    const bound = 60 * MIN;
    expect(
      decideSnapshotPrune({ ...busy, now: 0, maxDeferralMs: bound }).allow,
    ).toBe(false);
    expect(
      decideSnapshotPrune({ ...busy, now: 59 * MIN, maxDeferralMs: bound }),
    ).toMatchObject({ allow: false, deferredForMs: 59 * MIN });
    expect(
      decideSnapshotPrune({ ...busy, now: 60 * MIN, maxDeferralMs: bound }),
    ).toEqual({ allow: true, reason: "deferral_bound", deferredForMs: bound });
    expect(getSnapshotPruneGateStats()).toEqual({
      deferred: 2,
      forced: 1,
      pending_projects: 0,
    });
    // The bound counts from the first deferral after each prune.
    expect(
      decideSnapshotPrune({ ...busy, now: 61 * MIN, maxDeferralMs: bound })
        .allow,
    ).toBe(false);
  });

  it("forgets a deferral once the host is idle and the prune ran", () => {
    decideSnapshotPrune({
      projectId: "p",
      backupsInFlight: 1,
      lifecycleActive: 0,
      now: 0,
    });
    expect(
      decideSnapshotPrune({
        projectId: "p",
        backupsInFlight: 0,
        lifecycleActive: 0,
        now: 10 * MIN,
      }),
    ).toEqual({ allow: true, reason: "idle", deferredForMs: 10 * MIN });
    expect(getSnapshotPruneGateStats().pending_projects).toBe(0);
  });

  it("tracks each project's bound separately", () => {
    const busy = { backupsInFlight: 1, lifecycleActive: 0, maxDeferralMs: MIN };
    decideSnapshotPrune({ ...busy, projectId: "a", now: 0 });
    decideSnapshotPrune({ ...busy, projectId: "b", now: 30_000 });
    expect(
      decideSnapshotPrune({ ...busy, projectId: "a", now: MIN }).allow,
    ).toBe(true);
    expect(
      decideSnapshotPrune({ ...busy, projectId: "b", now: MIN }).allow,
    ).toBe(false);
  });
});

describe("a bound of 0", () => {
  it("never defers", () => {
    expect(
      decideSnapshotPrune({
        projectId: "p",
        backupsInFlight: 2,
        lifecycleActive: 1,
        now: 0,
        maxDeferralMs: 0,
      }),
    ).toMatchObject({ allow: true, reason: "deferral_bound" });
  });
});

describe("retrying deferred prunes, independent of the snapshot schedule", () => {
  const counts = { frequent: 4 };
  let busy = { backupsInFlight: 0, lifecycleActive: 0 };
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    busy = { backupsInFlight: 0, lifecycleActive: 0 };
    clock = 0;
  });

  function defer(projectId: string) {
    // what the scheduled snapshot does when the gate declines
    const d = decideSnapshotPrune({
      projectId,
      backupsInFlight: 1,
      lifecycleActive: 0,
      now: clock,
      maxDeferralMs: 60 * MIN,
    });
    expect(d.allow).toBe(false);
    notePendingPrune(projectId, { counts, validate: async () => undefined });
  }

  it("prunes as soon as the host is quiet, without another scheduled visit", async () => {
    defer("p");
    const prune = jest.fn(async () => undefined);
    busy = { backupsInFlight: 1, lifecycleActive: 0 };
    clock = 5 * MIN;
    expect(
      await retryDeferredPrunes({
        prune,
        busy: () => busy,
        now,
        maxDeferralMs: 60 * MIN,
      }),
    ).toEqual({ pruned: [], waiting: 1 });
    busy = { backupsInFlight: 0, lifecycleActive: 0 };
    clock = 6 * MIN;
    expect(
      await retryDeferredPrunes({
        prune,
        busy: () => busy,
        now,
        maxDeferralMs: 60 * MIN,
      }),
    ).toEqual({ pruned: ["p"], waiting: 0 });
    expect(prune).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ counts }),
    );
  });

  it("prunes at the bound even if the host never quiets down", async () => {
    defer("p");
    const prune = jest.fn(async () => undefined);
    busy = { backupsInFlight: 3, lifecycleActive: 2 };
    for (clock = MIN; clock < 60 * MIN; clock += MIN) {
      await retryDeferredPrunes({
        prune,
        busy: () => busy,
        now,
        maxDeferralMs: 60 * MIN,
      });
    }
    expect(prune).not.toHaveBeenCalled();
    clock = 60 * MIN;
    expect(
      (
        await retryDeferredPrunes({
          prune,
          busy: () => busy,
          now,
          maxDeferralMs: 60 * MIN,
        })
      ).pruned,
    ).toEqual(["p"]);
    expect(getSnapshotPruneGateStats()).toMatchObject({
      forced: 1,
      pending_projects: 0,
    });
  });

  it("keeps a failed prune pending, with a fresh bound", async () => {
    defer("p");
    const prune = jest
      .fn()
      .mockRejectedValueOnce(new Error("btrfs busy"))
      .mockResolvedValue(undefined);
    clock = MIN;
    expect(await retryDeferredPrunes({ prune, busy: () => busy, now })).toEqual(
      { pruned: [], waiting: 1 },
    );
    clock = 2 * MIN;
    expect(
      (await retryDeferredPrunes({ prune, busy: () => busy, now })).pruned,
    ).toEqual(["p"]);
  });

  it("drops the retry when a scheduled snapshot prunes first", async () => {
    defer("p");
    clearPendingPrune("p");
    const prune = jest.fn(async () => undefined);
    expect(await retryDeferredPrunes({ prune, busy: () => busy, now })).toEqual(
      { pruned: [], waiting: 0 },
    );
    expect(prune).not.toHaveBeenCalled();
  });
});

describe("maxPruneDeferralMs", () => {
  it("reads the override and falls back to one hour", () => {
    expect(maxPruneDeferralMs(undefined)).toBe(DEFAULT_MAX_PRUNE_DEFERRAL_MS);
    expect(maxPruneDeferralMs("")).toBe(DEFAULT_MAX_PRUNE_DEFERRAL_MS);
    expect(maxPruneDeferralMs("nope")).toBe(DEFAULT_MAX_PRUNE_DEFERRAL_MS);
    expect(maxPruneDeferralMs("-5")).toBe(DEFAULT_MAX_PRUNE_DEFERRAL_MS);
    expect(maxPruneDeferralMs("0")).toBe(0);
    expect(maxPruneDeferralMs("900000")).toBe(900_000);
  });
});
