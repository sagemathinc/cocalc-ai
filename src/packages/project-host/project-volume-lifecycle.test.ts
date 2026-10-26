/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  invalidateProjectVolumeLifecycle,
  projectVolumeLifecycleBusy,
  resetProjectVolumeLifecycleForTesting,
  withCurrentProjectVolumeLifecycleLock,
  withProjectVolumeLifecycleLock,
  type ProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

describe("project volume lifecycle coordination", () => {
  beforeEach(() => {
    resetProjectVolumeLifecycleForTesting();
  });

  it("serializes one project while allowing other projects through", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = withProjectVolumeLifecycleLock("project-1", async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = withProjectVolumeLifecycleLock("project-1", async () => {
      order.push("second");
    });
    const unrelated = withProjectVolumeLifecycleLock("project-2", async () => {
      order.push("unrelated");
    });

    await unrelated;
    expect(order).toEqual(["first:start", "unrelated"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "unrelated", "first:end", "second"]);
  });

  it("invalidates preparation generations before queued deletion runs", async () => {
    const project_id = "project-1";
    const preparedGeneration =
      currentProjectVolumeLifecycleGeneration(project_id);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withProjectVolumeLifecycleLock(project_id, async () => {
      await firstBlocked;
    });

    invalidateProjectVolumeLifecycle(project_id);
    const stalePreparation = withProjectVolumeLifecycleLock(
      project_id,
      async () => {
        assertProjectVolumeLifecycleGeneration(project_id, preparedGeneration);
      },
    );
    releaseFirst();
    await first;
    await expect(stalePreparation).rejects.toThrow(
      "project volume lifecycle changed",
    );
  });

  it("skips queued work when volume deletion invalidates its generation", async () => {
    const project_id = "project-1";
    const expectedGeneration =
      currentProjectVolumeLifecycleGeneration(project_id);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withProjectVolumeLifecycleLock(project_id, async () => {
      await firstBlocked;
    });
    const run = jest.fn(async () => "ran");
    const staleMaintenance = withCurrentProjectVolumeLifecycleLock(
      project_id,
      expectedGeneration,
      run,
    );

    invalidateProjectVolumeLifecycle(project_id);
    releaseFirst();
    await first;

    await expect(staleMaintenance).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("lets queued work run while the holder works unlocked, then reacquires behind it", async () => {
    const project_id = "project-1";
    const order: string[] = [];
    let finishUpload!: () => void;
    const uploading = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const backup = withProjectVolumeLifecycleLock(project_id, async (lock) => {
      order.push("snapshot");
      await lock.unlocked(async () => {
        uploadStarted();
        await uploading;
        order.push("upload done");
      });
      order.push("retention");
    });
    await started;
    await withProjectVolumeLifecycleLock(project_id, async () => {
      order.push("scratch reset");
    });
    expect(order).toEqual(["snapshot", "scratch reset"]);

    let releaseLater!: () => void;
    const later = withProjectVolumeLifecycleLock(project_id, async () => {
      await new Promise<void>((resolve) => {
        releaseLater = resolve;
      });
      order.push("later");
    });
    finishUpload();
    await new Promise((resolve) => setImmediate(resolve));
    // The holder queued behind work that took the lock while it was away.
    expect(order).toEqual(["snapshot", "scratch reset", "upload done"]);
    releaseLater();
    await Promise.all([backup, later]);
    expect(order).toEqual([
      "snapshot",
      "scratch reset",
      "upload done",
      "later",
      "retention",
    ]);
  });

  it("rejects a handle used after its scope ended without wedging the lock", async () => {
    const project_id = "project-1";
    let escaped: ProjectVolumeLifecycleLock | undefined;
    await withProjectVolumeLifecycleLock(project_id, async (lock) => {
      escaped = lock;
    });
    const inner = jest.fn(async () => undefined);
    await expect(escaped!.unlocked(inner)).rejects.toThrow(
      "after its scope ended",
    );
    expect(inner).not.toHaveBeenCalled();
    await expect(
      withProjectVolumeLifecycleLock(project_id, async () => "next"),
    ).resolves.toBe("next");
  });

  it("does not keep a lock reacquired by an unawaited unlocked section", async () => {
    const project_id = "project-1";
    let finishInner!: () => void;
    const innerDone = new Promise<void>((resolve) => {
      finishInner = resolve;
    });
    let pending: Promise<unknown> | undefined;
    await withProjectVolumeLifecycleLock(project_id, async (lock) => {
      pending = lock.unlocked(async () => await innerDone);
    });
    finishInner();
    await pending;
    await expect(
      withProjectVolumeLifecycleLock(project_id, async () => "next"),
    ).resolves.toBe("next");
  });

  it("releases a reacquisition that completes after the scope ended", async () => {
    const project_id = "project-1";
    let releaseOther!: () => void;
    let pending: Promise<unknown> | undefined;
    let other: Promise<unknown> | undefined;
    const holder = withProjectVolumeLifecycleLock(project_id, async (lock) => {
      pending = lock.unlocked(async () => {
        // Someone else takes the lock while we are unlocked, so the
        // reacquisition below has to wait for them.
        other = withProjectVolumeLifecycleLock(project_id, async () => {
          await new Promise<void>((resolve) => {
            releaseOther = resolve;
          });
        });
        await new Promise((resolve) => setImmediate(resolve));
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
    await holder;
    releaseOther();
    await Promise.all([pending, other]);
    await expect(
      withProjectVolumeLifecycleLock(project_id, async () => "next"),
    ).resolves.toBe("next");
  });

  it("reacquires the lock even when unlocked work fails", async () => {
    const project_id = "project-1";
    const order: string[] = [];
    const holder = withProjectVolumeLifecycleLock(project_id, async (lock) => {
      await expect(
        lock.unlocked(async () => {
          throw new Error("upload failed");
        }),
      ).rejects.toThrow("upload failed");
      const queued = withProjectVolumeLifecycleLock(project_id, async () => {
        order.push("queued");
      });
      await new Promise((resolve) => setImmediate(resolve));
      order.push("holder");
      return { queued };
    });
    await (
      await holder
    ).queued;
    expect(order).toEqual(["holder", "queued"]);
  });

  it("reports a project busy while its lock is held or awaited", async () => {
    expect(projectVolumeLifecycleBusy("project-1")).toBe(false);
    let release!: () => void;
    const held = withProjectVolumeLifecycleLock(
      "project-1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(projectVolumeLifecycleBusy("project-1")).toBe(true);
    expect(projectVolumeLifecycleBusy("project-2")).toBe(false);
    release();
    await held;
    expect(projectVolumeLifecycleBusy("project-1")).toBe(false);
  });
});
