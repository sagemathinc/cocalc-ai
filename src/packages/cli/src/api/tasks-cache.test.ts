import assert from "node:assert/strict";
import test from "node:test";

import { createTasksApi, resolveTasksSessionCacheEntry } from "./tasks";

test("read-only tasks requests reuse an existing writable session", () => {
  const writableKey = JSON.stringify({
    project_id: "00000000-1000-4000-8000-000000000000",
    path: "/tmp/example.tasks",
    readOnly: false,
  });
  const sessionPromises = new Map<string, unknown>([[writableKey, {}]]);

  const result = resolveTasksSessionCacheEntry({
    projectId: "00000000-1000-4000-8000-000000000000",
    path: "/tmp/example.tasks",
    readOnly: true,
    sessionPromises,
  });

  assert.deepEqual(result, {
    key: writableKey,
    readOnly: false,
  });
});

test("read-only tasks requests open a read-only session when no writable session exists", () => {
  const result = resolveTasksSessionCacheEntry({
    projectId: "00000000-1000-4000-8000-000000000000",
    path: "/tmp/example.tasks",
    readOnly: true,
    sessionPromises: new Map(),
  });

  assert.deepEqual(result, {
    key: JSON.stringify({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/example.tasks",
      readOnly: true,
    }),
    readOnly: true,
  });
});

test("reads switch to the writable tasks session after a mutation", async () => {
  const sessions = {
    readOnly: {
      getSnapshotCalls: 0,
      getTaskCalls: 0,
      async getSnapshot() {
        this.getSnapshotCalls += 1;
        return {
          tasks: [{ task_id: "task-1", desc: "stale open task" }],
          taskCount: 1,
          revision: "ro",
        };
      },
      async getTask() {
        this.getTaskCalls += 1;
        return { task_id: "task-1", desc: "stale open task" };
      },
    },
    writable: {
      getSnapshotCalls: 0,
      getTaskCalls: 0,
      async getSnapshot() {
        this.getSnapshotCalls += 1;
        return {
          tasks: [],
          taskCount: 0,
          revision: "rw",
        };
      },
      async getTask() {
        this.getTaskCalls += 1;
        return { task_id: "task-1", desc: "fresh done task", done: true };
      },
      async setDone() {
        return {
          changedTaskIds: ["task-1"],
          revision: "rw",
        };
      },
    },
  };

  const api = createTasksApi({
    withProjectTasksSession: async (_ctx, options, fn) => {
      const session =
        options.readOnly === true ? sessions.readOnly : sessions.writable;
      return await fn({
        project: {
          project_id: "00000000-1000-4000-8000-000000000000",
          title: "Test Project",
          host_id: null,
        },
        path: options.path,
        session: session as any,
      });
    },
  });

  const doc = api.bindDocument(undefined, {
    path: "/tmp/example.tasks",
  });

  const before = await doc.getSnapshot({ includeDone: false });
  const mutation = await doc.setDone("task-1", true);
  const after = await doc.getSnapshot({ includeDone: false });
  const task = await doc.getTask("task-1");

  assert.equal(before.revision, "ro");
  assert.equal(mutation.task?.done, true);
  assert.equal(after.revision, "rw");
  assert.deepEqual(after.tasks, []);
  assert.equal(task.task?.done, true);
  assert.equal(sessions.readOnly.getSnapshotCalls, 1);
  assert.equal(sessions.readOnly.getTaskCalls, 0);
  assert.equal(sessions.writable.getSnapshotCalls, 1);
  assert.equal(sessions.writable.getTaskCalls, 2);
});
