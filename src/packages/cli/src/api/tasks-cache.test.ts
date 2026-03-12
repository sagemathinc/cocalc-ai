import assert from "node:assert/strict";
import test from "node:test";

import { resolveTasksSessionCacheEntry } from "./tasks";

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
