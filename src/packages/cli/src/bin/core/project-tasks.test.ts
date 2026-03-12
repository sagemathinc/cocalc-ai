import assert from "node:assert/strict";
import test from "node:test";

import { resolveTasksSessionCacheEntry } from "./project-tasks";

test("read-only project tasks requests reuse an existing writable session", () => {
  const writableKey = JSON.stringify({
    project_id: "00000000-1000-4000-8000-000000000000",
    path: "/tmp/example.tasks",
    readOnly: false,
  });
  const sessionPromises = new Map<string, Promise<unknown>>([
    [writableKey, Promise.resolve({})],
  ]);

  const result = resolveTasksSessionCacheEntry({
    projectId: "00000000-1000-4000-8000-000000000000",
    path: "/tmp/example.tasks",
    readOnly: true,
    sessionPromises: sessionPromises as any,
  });

  assert.deepEqual(result, {
    key: writableKey,
    readOnly: false,
  });
});

test("read-only project tasks requests open a read-only session when no writable session exists", () => {
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
