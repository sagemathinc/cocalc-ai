/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { stableDraftKeyFromThreadKey } from "@cocalc/chat";

import { createAgentFromCopy } from "./agent-create";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function fakeDeps({ runtime }: { runtime?: { profile: { id: string } } } = {}) {
  const calls: Record<string, any[]> = {};
  const record = (name: string, value: any) => {
    (calls[name] ??= []).push(value);
  };
  const deps = {
    accountId: "acct",
    hub: {
      agent: {
        listNamedAgents: async () => ({
          agents: [
            {
              name: "support",
              endpoint: { project_id: PROJECT, agent_id: "agent-support" },
              path: "/home/user/.local/share/cocalc/agents/s.chat",
              thread_id: "source-thread",
              project_title: "lite4 - support",
              thread_title: "support",
            },
          ],
        }),
        getPaymentSelections: async (opts) => {
          record("getPaymentSelections", opts);
          return {
            selections: [],
            defaults: { "claude-code": { mode: "subscription", id: "c1" } },
          };
        },
        copyPaymentSelection: async (opts) => record("copy", opts),
        resolveIdentity: async () => undefined,
        registerIdentity: async (opts) => {
          record("register", opts);
          return { agent_id: "agent-new" };
        },
        nameAgent: async (opts) => record("name", opts),
      },
    },
    forkThread: async (opts) => {
      record("fork", opts);
      if (runtime) await opts.resolveHarnessCredential(runtime);
      return {
        project_id: PROJECT,
        path: opts.path,
        thread_id: "new-thread",
        session: runtime ? "harness" : "codex",
        copy_payment_selection: !runtime,
      };
    },
    setDraft: async (key, value, ttl) => record("draft", { key, value, ttl }),
  };
  return { deps, calls };
}

test("agent create forks the source agent, names it and leaves an unsent draft", async () => {
  const { deps, calls } = fakeDeps();
  const result = await createAgentFromCopy(deps as any, {
    name: "@Star-Release",
    from: "@support",
    draft: "  Build a new CoCalc Star release.  ",
  });
  assert.equal(result.name, "star-release");
  assert.equal(result.agent_id, "agent-new");
  assert.deepEqual(calls.fork[0].sourceThreadId, "source-thread");
  assert.equal(calls.fork[0].title, "star-release");
  assert.deepEqual(calls.copy[0], {
    from: {
      project_id: PROJECT,
      thread_id: "source-thread",
      path: "/home/user/.local/share/cocalc/agents/s.chat",
    },
    to: {
      project_id: PROJECT,
      thread_id: "new-thread",
      path: "/home/user/.local/share/cocalc/agents/s.chat",
    },
  });
  assert.deepEqual(calls.name[0].endpoint, {
    project_id: PROJECT,
    agent_id: "agent-new",
  });
  assert.equal(calls.name[0].name, "star-release");
  const draft = calls.draft[0];
  assert.equal(
    draft.key,
    `${PROJECT}:/home/user/.local/share/cocalc/agents/s.chat:${stableDraftKeyFromThreadKey("new-thread")}`,
  );
  assert.equal(draft.value.text, "Build a new CoCalc Star release.");
  assert.equal(draft.value.version, 1);
  assert.ok(draft.ttl > 0);
});

test("agent create resolves the Claude credential from payment selections", async () => {
  const { deps, calls } = fakeDeps({
    runtime: { profile: { id: "claude-code" } },
  });
  await createAgentFromCopy(deps as any, { name: "copy", from: "support" });
  assert.equal(calls.getPaymentSelections.length, 1);
  assert.equal(calls.draft, undefined);
});

test("agent create refuses unknown sources and duplicate names", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    createAgentFromCopy(deps as any, { name: "x", from: "missing" }),
    /no agent named missing/,
  );
  await assert.rejects(
    createAgentFromCopy(deps as any, { name: "support", from: "support" }),
    /already have an agent named @support/,
  );
  await assert.rejects(
    createAgentFromCopy(deps as any, { name: "9bad", from: "support" }),
    /agent name must be/,
  );
});

test("agent create reports partial failures after the fork without hiding what exists", async () => {
  const failingDraft = fakeDeps();
  failingDraft.deps.setDraft = async () => {
    throw new Error("akv unavailable");
  };
  const result = await createAgentFromCopy(failingDraft.deps as any, {
    name: "copy",
    from: "support",
    draft: "hello",
  });
  assert.equal(result.agent_id, "agent-new");
  assert.equal(result.draft, null);
  assert.equal(result.draft_verified, false);
  assert.match((result.warnings as string[])[0], /draft could not be saved/);

  const failingName = fakeDeps();
  failingName.deps.hub.agent.nameAgent = async () => {
    throw new Error("name taken");
  };
  await assert.rejects(
    createAgentFromCopy(failingName.deps as any, {
      name: "copy",
      from: "support",
    }),
    /forked conversation was created \(thread new-thread.*could not be named @copy: Error: name taken/,
  );
});
