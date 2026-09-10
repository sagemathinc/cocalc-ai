import assert from "node:assert/strict";
import test from "node:test";
import { createBackendExecApi } from "./exec";

for (const [kind, object] of Object.entries({
  file: { file: { path: "/home/user/policy.md" } },
  actions: {
    actions: [
      { id: "reply", title: "Reply", target: "Ticket 123", draft: "Draft" },
    ],
  },
  github_pr: {
    github_pr: {
      repository: "sagemathinc/cocalc-ai",
      number: 509,
      state: "open",
      draft: true,
      checks: "unknown",
      fetched_at: "2026-09-10T00:00:00Z",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
    },
  },
})) {
  test(`artifact scripting forwards ${kind} creation, reading, update and retry`, async () => {
    const calls: any[] = [];
    const response = { artifact: { kind }, base: "observed base" };
    const ctx = { request: "object-test" };
    const api = createBackendExecApi(ctx, {
      projectChatArtifactData: async (options: any) => {
        calls.push(options);
        return response;
      },
    } as any);
    const options = {
      path: "objects.chat",
      threadId: "origin-thread",
      projectIdentifier: "project",
      experimental: true,
    };
    const doc = api.artifacts.open(options);
    const payload = {
      title: "Object",
      markdown: "Description",
      message_id: "producing-message",
      operation_id: "create-operation",
      ...object,
    };
    assert.equal(await doc.create("stable-id", payload), response);
    assert.equal(await doc.read("stable-id"), response);
    const update = {
      ...payload,
      operation_id: "update-operation",
      base: response.base,
    };
    assert.equal(await doc.update("stable-id", update), response);
    assert.equal(await doc.update("stable-id", update), response);
    assert.deepEqual(
      calls.map((call) => call.action),
      ["create", "read", "update", "update"],
    );
    for (const call of calls) {
      assert.deepEqual(
        { ...call, action: undefined, payload: undefined },
        {
          ctx,
          ...options,
          artifactId: "stable-id",
          action: undefined,
          payload: undefined,
        },
      );
    }
    assert.equal(calls[0].payload, payload);
    assert.deepEqual(calls[2], calls[3]);
    assert.equal(calls[2].payload, update);
  });
}

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
    experimental: true,
  });
  await doc.context("2026-09-09T00:00:00Z");
  await doc.read("artifact");
  const payload = {
    message_id: "message",
    operation_id: "retry-id",
    title: "Draft",
    markdown: "New",
    base: "exact base",
    actions: [
      {
        id: "reply",
        title: "Reply",
        target: "Ticket 123",
        draft: "Proposed reply",
      },
    ],
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
    assert.equal(call.experimental, true);
  }
  assert.equal(calls[2].payload, payload);
  assert.deepEqual(calls[2].payload.actions, payload.actions);
});
