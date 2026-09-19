/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  freshAgentExecutionConfig,
  suggestedAgentName,
} from "./new-agent-defaults";
import {
  readAgentSubscriptionSelection,
  writeAgentSubscriptionSelection,
} from "./agent-subscription-selection";
import { relativeAgentWorkingDirectory } from "./workspace-path";

function agent(name: string): NamedAgent {
  return {
    account_id: "account",
    name,
    endpoint: { project_id: "project", agent_id: `id-${name}` },
    path: "/tmp/agent.chat",
    thread_id: `thread-${name}`,
    available: true,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
}

describe("new agent defaults", () => {
  beforeEach(() => localStorage.clear());

  it("allocates simple increasing names without reusing observed numbers", () => {
    expect(suggestedAgentName([], "account")).toBe("agent-1");
    expect(
      suggestedAgentName([agent("agent-1"), agent("agent-4")], "account"),
    ).toBe("agent-5");
  });

  it("does not carry Codex runtime identity into a fresh agent", () => {
    expect(
      freshAgentExecutionConfig({
        sessionId: "codex-session",
        model: "gpt-test",
        reasoning: "high",
        paymentSource: "subscription",
        workingDirectory: "/home/user/work",
      }),
    ).toEqual({
      model: "gpt-test",
      reasoning: "high",
      paymentSource: "subscription",
      workingDirectory: "/home/user/work",
    });
  });

  it("carries an exact subscription selection to the new thread", () => {
    writeAgentSubscriptionSelection({
      accountId: "account",
      projectId: "project",
      threadId: "new-thread",
      credentialId: "credential-2",
    });
    expect(
      readAgentSubscriptionSelection({
        accountId: "account",
        projectId: "project",
        threadId: "new-thread",
      }),
    ).toBe("credential-2");
  });
});

describe("agent workspace paths", () => {
  it("shows working directories relative to the project home", () => {
    expect(
      relativeAgentWorkingDirectory("/home/user/scratch", "/home/user"),
    ).toBe("scratch/");
    expect(relativeAgentWorkingDirectory("/home/user", "/home/user")).toBe(
      "~/",
    );
  });
});
