import { randomUUID } from "node:crypto";
import { getProject, upsertProject } from "./sqlite/projects";
import {
  applyProjectRuntimeAuthorityUpdate,
  MAX_QUEUED_LIFECYCLE_OPERATIONS_PER_PROJECT,
  resetProjectRuntimeLifecycleForTesting,
  withProjectRuntimeLifecycle,
} from "./runtime-lifecycle";

describe("project runtime lifecycle", () => {
  let project_id: string;

  beforeEach(() => {
    project_id = randomUUID();
    resetProjectRuntimeLifecycleForTesting();
    upsertProject({ project_id, runtime_lifecycle_revision: 0 });
  });

  test("serializes a stale start behind stop and rejects it", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const events: string[] = [];
    const stop = withProjectRuntimeLifecycle({
      project_id,
      revision: 2,
      require_revision: true,
      fn: async () => {
        events.push("stop");
        await stopGate;
      },
    });
    const staleStart = withProjectRuntimeLifecycle({
      project_id,
      revision: 1,
      fn: async () => {
        events.push("stale-start");
      },
    });

    await Promise.resolve();
    releaseStop();
    await stop;
    await expect(staleStart).rejects.toThrow("stale runtime lifecycle");
    expect(events).toEqual(["stop"]);
    expect(getProject(project_id)?.runtime_lifecycle_revision).toBe(2);
  });

  test("lets an older active start finish only before the fenced stop", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const events: string[] = [];
    const oldStart = withProjectRuntimeLifecycle({
      project_id,
      revision: 0,
      fn: async () => {
        events.push("start-begin");
        await startGate;
        events.push("start-end");
      },
    });
    const stop = withProjectRuntimeLifecycle({
      project_id,
      revision: 1,
      require_revision: true,
      fn: async () => {
        events.push("stop");
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["start-begin"]);
    releaseStart();
    await Promise.all([oldStart, stop]);
    expect(events).toEqual(["start-begin", "start-end", "stop"]);
    expect(getProject(project_id)?.runtime_lifecycle_revision).toBe(1);
  });

  test("allows legacy starts only before the first fenced stop", async () => {
    await expect(
      withProjectRuntimeLifecycle({
        project_id,
        fn: async () => "legacy",
      }),
    ).resolves.toBe("legacy");
    await withProjectRuntimeLifecycle({
      project_id,
      revision: 1,
      require_revision: true,
      fn: async () => undefined,
    });
    await expect(
      withProjectRuntimeLifecycle({
        project_id,
        fn: async () => undefined,
      }),
    ).rejects.toThrow("runtime lifecycle revision required");
  });

  test.each(["user sync", "authorized-key sync", "project registration"])(
    "rejects a stale delayed %s after a newer restart fence",
    async (operation) => {
      await withProjectRuntimeLifecycle({
        project_id,
        revision: 4,
        require_revision: true,
        fn: async () => undefined,
      });

      await expect(
        withProjectRuntimeLifecycle({
          project_id,
          revision: 3,
          fn: async () => operation,
        }),
      ).rejects.toThrow("stale runtime lifecycle");
    },
  );

  test("authority updates do not wait behind a start that hangs", async () => {
    let releaseStart!: () => void;
    const hung = withProjectRuntimeLifecycle({
      project_id,
      revision: 2,
      fn: async () =>
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    });
    await Promise.resolve();

    expect(
      applyProjectRuntimeAuthorityUpdate({
        project_id,
        revision: 2,
        fn: () => "users",
      }),
    ).toBe("users");
    // The restart fence still holds without the queue.
    expect(() =>
      applyProjectRuntimeAuthorityUpdate({
        project_id,
        revision: 1,
        fn: () => "stale",
      }),
    ).toThrow("stale runtime lifecycle");
    expect(() =>
      applyProjectRuntimeAuthorityUpdate({ project_id, fn: () => "legacy" }),
    ).toThrow("runtime lifecycle revision required");
    // A newer authority revision is recorded, fencing older queued work.
    applyProjectRuntimeAuthorityUpdate({
      project_id,
      revision: 3,
      fn: () => undefined,
    });
    expect(getProject(project_id)?.runtime_lifecycle_revision).toBe(3);
    const staleStop = withProjectRuntimeLifecycle({
      project_id,
      revision: 2,
      fn: async () => "stop",
    });

    releaseStart();
    await hung;
    await expect(staleStop).rejects.toThrow("stale runtime lifecycle");
  });

  test("caps the operations one project can queue", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const running = [
      withProjectRuntimeLifecycle({ project_id, fn: async () => await gate }),
    ];
    for (let i = 1; i < MAX_QUEUED_LIFECYCLE_OPERATIONS_PER_PROJECT; i++) {
      running.push(
        withProjectRuntimeLifecycle({ project_id, fn: async () => undefined }),
      );
    }

    const refused = withProjectRuntimeLifecycle({
      project_id,
      fn: async () => undefined,
    });
    await expect(refused).rejects.toThrow(
      `${MAX_QUEUED_LIFECYCLE_OPERATIONS_PER_PROJECT} runtime lifecycle operations waiting`,
    );
    await expect(refused).rejects.toMatchObject({ code: 503 });
    // Other projects on the host are unaffected.
    const other = randomUUID();
    upsertProject({ project_id: other, runtime_lifecycle_revision: 0 });
    await expect(
      withProjectRuntimeLifecycle({ project_id: other, fn: async () => "ok" }),
    ).resolves.toBe("ok");

    releaseStart();
    await Promise.all(running);
    await expect(
      withProjectRuntimeLifecycle({ project_id, fn: async () => "after" }),
    ).resolves.toBe("after");
  });
});
