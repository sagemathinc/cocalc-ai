import assert from "node:assert/strict";
import test from "node:test";

import { mergeThreadConfigRecord } from "./project-chat";

test("mergeThreadConfigRecord preserves unrelated thread metadata while updating automation settings", () => {
  const merged = mergeThreadConfigRecord({
    existing: {
      event: "chat-thread-config",
      sender_id: "__thread_config__:thread-1",
      date: "1970-01-01T00:00:00.000Z",
      thread_id: "thread-1",
      name: "Agent thread",
      agent_kind: "acp",
      agent_mode: "interactive",
      automation_config: {
        enabled: true,
        prompt: "run daily",
        local_time: "09:00",
        timezone: "UTC",
      },
      automation_state: {
        status: "active",
      },
      updated_at: "2026-03-16T00:00:00.000Z",
      updated_by: "old-account",
      schema_version: 2,
    },
    threadId: "thread-1",
    accountId: "new-account",
    patch: {
      automation_state: {
        status: "paused",
      },
    },
  });

  assert.equal(merged.thread_id, "thread-1");
  assert.equal(merged.name, "Agent thread");
  assert.equal(merged.agent_kind, "acp");
  assert.deepEqual(merged.automation_config, {
    enabled: true,
    prompt: "run daily",
    local_time: "09:00",
    timezone: "UTC",
  });
  assert.deepEqual(merged.automation_state, { status: "paused" });
  assert.equal(merged.updated_by, "new-account");
});
