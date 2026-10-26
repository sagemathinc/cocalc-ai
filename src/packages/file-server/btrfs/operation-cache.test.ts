/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  clearBtrfsOperationCachesForTest,
  configureBtrfsBackgroundMutationGuard,
  getBtrfsMutationContext,
  getBtrfsMutationLockStatus,
  withBtrfsMutationContext,
  withBtrfsMutationLock,
} from "./operation-cache";

describe("btrfs mutation lock", () => {
  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
  });

  afterEach(() => {
    clearBtrfsOperationCachesForTest();
  });

  it("hands the lock to waiters in FIFO order", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "first",
      run: async () => {
        order.push("first:start");
        firstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first:end");
      },
    });
    await started;

    const second = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "second",
      run: async () => {
        order.push("second");
      },
    });

    expect(getBtrfsMutationLockStatus()).toEqual([
      expect.objectContaining({
        mount: "/mnt/test",
        holder_operation: "first",
        queued: 1,
      }),
    ]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(getBtrfsMutationLockStatus()).toEqual([]);
  });

  it("times out and removes a blocked waiter without poisoning the lock", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "stuck-holder",
      run: async () => {
        firstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    });
    await started;

    await expect(
      withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "bounded-waiter",
        wait_ms: 10,
        run: async () => undefined,
      }),
    ).rejects.toThrow("timed out after 10ms waiting for btrfs mutation lock");
    expect(getBtrfsMutationLockStatus()).toEqual([
      expect.objectContaining({
        holder_operation: "stuck-holder",
        queued: 0,
      }),
    ]);

    releaseFirst();
    await first;
    await expect(
      withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "after-timeout",
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("orders queued lifecycle work ahead of scheduled work", async () => {
    let releaseHolder!: () => void;
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    const order: string[] = [];
    const holder = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "holder",
      run: async () => {
        holderStarted();
        await new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
      },
    });
    await started;

    const scheduled = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "scheduled",
      context: { priority: "scheduled", project_id: "project-scheduled" },
      run: async () => {
        order.push("scheduled");
      },
    });
    const lifecycle = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "lifecycle",
      context: { priority: "lifecycle", project_id: "project-lifecycle" },
      run: async () => {
        order.push("lifecycle");
      },
    });

    expect(getBtrfsMutationLockStatus()).toEqual([
      expect.objectContaining({
        queued: 2,
        next_waiter_priority: "lifecycle",
        next_waiter_project_id: "project-lifecycle",
      }),
    ]);
    releaseHolder();
    await Promise.all([holder, scheduled, lifecycle]);
    expect(order).toEqual(["lifecycle", "scheduled"]);
  });

  it("propagates operation context without changing every Btrfs call", async () => {
    await withBtrfsMutationContext(
      {
        operation_id: "operation-1",
        project_id: "project-1",
        priority: "scheduled",
        operation_class: "scheduled_snapshot",
        checkpointable: true,
      },
      async () => {
        await withBtrfsMutationLock({
          mount: "/mnt/test",
          operation: "snapshot-delete",
          run: async () => {
            expect(getBtrfsMutationContext().mutation_lock_held).toBe(true);
            expect(getBtrfsMutationLockStatus()).toEqual([
              expect.objectContaining({
                operation_id: "operation-1",
                project_id: "project-1",
                priority: "scheduled",
                operation_class: "scheduled_snapshot",
                checkpointable: true,
              }),
            ]);
          },
        });
      },
    );
  });

  it("rechecks scheduled mutations at the lock boundary", async () => {
    configureBtrfsBackgroundMutationGuard(() => "lifecycle_active");
    await expect(
      withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "scheduled-snapshot",
        context: { priority: "scheduled" },
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "BtrfsMutationDeferredError",
      reason: "lifecycle_active",
    });
    await expect(
      withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "project-start",
        context: { priority: "lifecycle" },
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("counts the mutations that passed the boundary in the caller's context", async () => {
    const mutations = { count: 0 };
    let refuse: string | undefined;
    configureBtrfsBackgroundMutationGuard(() => refuse);
    const mutate = () =>
      withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "snapshot-create",
        run: async () => undefined,
      });
    await withBtrfsMutationContext(
      { priority: "scheduled", mutations },
      async () => {
        await mutate();
        refuse = "io_pressure_recovery";
        await expect(mutate()).rejects.toMatchObject({
          name: "BtrfsMutationDeferredError",
        });
      },
    );
    expect(mutations.count).toBe(1);
    configureBtrfsBackgroundMutationGuard(undefined);
  });

  it("defers scheduled work if lifecycle arrives while it waits", async () => {
    let blocked = false;
    let releaseHolder!: () => void;
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => (holderStarted = resolve));
    configureBtrfsBackgroundMutationGuard(() =>
      blocked ? "lifecycle_active" : undefined,
    );
    const holder = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "holder",
      run: async () => {
        holderStarted();
        await new Promise<void>((resolve) => (releaseHolder = resolve));
      },
    });
    await started;
    const run = jest.fn(async () => undefined);
    const scheduled = withBtrfsMutationLock({
      mount: "/mnt/test",
      operation: "scheduled",
      context: { priority: "scheduled" },
      run,
    });
    blocked = true;
    releaseHolder();
    await holder;
    await expect(scheduled).rejects.toMatchObject({
      name: "BtrfsMutationDeferredError",
      reason: "lifecycle_active",
    });
    expect(run).not.toHaveBeenCalled();
    expect(getBtrfsMutationLockStatus()).toEqual([]);
  });
});
