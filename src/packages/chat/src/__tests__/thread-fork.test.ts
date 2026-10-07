/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { buildForkedThread, planThreadFork } from "../thread-fork";
import {
  chatComposerDraftKey,
  chatComposerDraftPayload,
  stableDraftKeyFromThreadKey,
} from "../composer-drafts";

const SESSION = "019a0000-0000-7000-8000-000000000001";
const FORKED = "019a0000-0000-7000-8000-000000000002";
const CLAUDE = {
  version: 1,
  kind: "acp",
  profile: {
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.85.1",
    cwd: "/home/user/work",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  },
};

function messages() {
  return [
    {
      event: "chat",
      message_id: "m1",
      thread_id: "t",
      date: "2026-10-01T00:00:00.000Z",
      history: [{ content: "Plan the release" }],
    },
    {
      event: "chat",
      message_id: "m2",
      thread_id: "t",
      parent_message_id: "m1",
      date: "2026-10-02T00:00:00.000Z",
      acp_thread_id: SESSION,
      history: [{ content: "ok" }],
    },
  ];
}

describe("planThreadFork", () => {
  it("forks the Codex session, inferring it from the latest reply", () => {
    const plan = planThreadFork({
      source: {
        threadId: "t",
        config: { agent_kind: "acp", acp_config: { model: "gpt-x" } },
        messages: messages(),
      },
      isAI: true,
    });
    expect(plan).toEqual({
      kind: "codex",
      sessionId: SESSION,
      config: { model: "gpt-x", sessionId: SESSION },
      shouldForkAcp: true,
    });
  });

  it("forks a harness session for Claude Code agents", () => {
    const plan = planThreadFork({
      source: {
        threadId: "t",
        config: { agent_runtime: CLAUDE, agent_session_id: SESSION },
        messages: [],
      },
      isAI: true,
    });
    expect(plan).toMatchObject({
      kind: "harness",
      sessionId: SESSION,
      runtime: { profile: { id: "claude-code" } },
    });
  });

  it("refuses to copy a harness agent without saved context", () => {
    expect(() =>
      planThreadFork({
        source: {
          threadId: "t",
          config: {
            agent_runtime: CLAUDE,
            agent_session_id: "",
          },
          messages: [],
        },
        isAI: true,
      }),
    ).toThrow(/no saved context/);
  });

  it("copies a plain human thread without forking anything", () => {
    expect(
      planThreadFork({
        source: { threadId: "t", config: {}, messages: messages().slice(0, 1) },
        isAI: false,
      }),
    ).toEqual({ kind: "copy", shouldForkAcp: false });
  });
});

describe("buildForkedThread", () => {
  it("builds the new root message and thread config with the forked session", () => {
    const source = {
      threadId: "t",
      config: {
        name: "support",
        agent_kind: "acp",
        acp_config: { model: "gpt-x" },
        thread_color: "#123456",
      },
      messages: messages(),
    };
    const plan = planThreadFork({ source, isAI: true });
    const forked = buildForkedThread({
      source,
      plan,
      forkedSessionId: FORKED,
      title: "star-release",
      sourceTitle: "support",
      isAI: true,
      senderId: "acct",
      now: new Date("2026-10-06T18:00:00.000Z"),
      messageId: "new-m",
      threadId: "new-t",
    });
    expect(forked.threadId).toBe("new-t");
    expect(forked.rootMessage).toMatchObject({
      event: "chat",
      message_id: "new-m",
      thread_id: "new-t",
      sender_id: "acct",
      name: "star-release",
      forked_from_title: "support",
      forked_from_root_date: "2026-10-01T00:00:00.000Z",
      forked_from_latest_message_date: "2026-10-02T00:00:00.000Z",
      date: "2026-10-06T18:00:00.000Z",
    });
    expect(forked.configPatch).toMatchObject({
      name: "star-release",
      thread_color: "#123456",
      agent_kind: "acp",
      agent_mode: "interactive",
      agent_model: "gpt-x",
      acp_config: { model: "gpt-x", sessionId: FORKED },
    });
    expect(forked.copyPaymentSelection).toBe(true);
  });

  it("rejects a fork that returned the original session", () => {
    const source = {
      threadId: "t",
      config: { agent_kind: "acp", acp_config: {} },
      messages: messages(),
    };
    const plan = planThreadFork({ source, isAI: true });
    expect(() =>
      buildForkedThread({
        source,
        plan,
        forkedSessionId: SESSION,
        title: "x",
        isAI: true,
        senderId: "acct",
        now: new Date(),
        messageId: "m",
        threadId: "n",
      }),
    ).toThrow(/independent/);
  });
});

describe("composer drafts", () => {
  it("uses the browser's key and payload format", () => {
    const key = stableDraftKeyFromThreadKey("thread-1");
    expect(key).toBeLessThan(0);
    expect(
      chatComposerDraftKey({
        project_id: "p",
        path: "a.chat",
        composerDraftKey: key,
      }),
    ).toBe(`p:a.chat:${key}`);
    expect(chatComposerDraftPayload("hi", 5)).toEqual({
      version: 1,
      text: "hi",
      updatedAt: 5,
      composing: false,
    });
  });
});
