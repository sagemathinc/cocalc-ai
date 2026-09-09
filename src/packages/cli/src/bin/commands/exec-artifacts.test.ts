import assert from "node:assert/strict";
import test from "node:test";
import { createBackendExecApi } from "./exec";

test("artifact scripting preserves explicit context and editing base", async () => {
  const calls: any[] = [];
  const ctx = { request: "test" };
  const api = createBackendExecApi(ctx, {
    projectChatArtifactData: async (options: any) => {
      calls.push(options);
      return { ok: true };
    },
  } as any);
  const doc = api.artifacts.open({
    path: "x.chat",
    threadId: "thread",
    projectIdentifier: "project",
  });
  await doc.context("2026-09-09T00:00:00Z");
  await doc.read("artifact");
  const payload = {
    message_id: "message",
    operation_id: "retry-id",
    title: "Draft",
    markdown: "New",
    base: "exact base",
  };
  await doc.update("artifact", payload);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["context", "read", "update"],
  );
  for (const call of calls) {
    assert.equal(call.ctx, ctx);
    assert.equal(call.threadId, "thread");
    assert.equal(call.path, "x.chat");
    assert.equal(call.projectIdentifier, "project");
  }
  assert.equal(calls[2].payload, payload);
});
