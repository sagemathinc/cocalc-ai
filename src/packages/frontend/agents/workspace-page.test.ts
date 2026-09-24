/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  freshAgentExecutionConfig,
  suggestedAgentName,
} from "./new-agent-defaults";
import { assertCodexFundingModelReady } from "@cocalc/frontend/chat/codex-submit-preflight";
import {
  readAgentSubscriptionSelection,
  writeAgentSubscriptionSelection,
} from "./agent-subscription-selection";
import {
  assertAgentWorkingDirectory,
  createAgentWorkingDirectory,
  effectiveNewAgentWorkingDirectory,
  MissingAgentWorkingDirectoryError,
  relativeAgentWorkingDirectory,
} from "./workspace-path";

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

  it("does not silently send a preferred model using transient membership funding", () => {
    const paymentSource: any = {
      source: "site-api-key",
      siteFundedCodex: {
        policy: { model: "gpt-5.6-luna", reasoning: "medium" },
      },
    };
    expect(() =>
      assertCodexFundingModelReady({
        config: {
          paymentSource: "auto",
          model: "gpt-6-sol",
          reasoning: "high",
        },
        paymentSource,
      }),
    ).toThrow(/Wait for your ChatGPT Plan/);
    expect(() =>
      assertCodexFundingModelReady({
        config: {
          paymentSource: "subscription",
          model: "gpt-6-sol",
        },
        paymentSource,
      }),
    ).toThrow(/selected payment source is not available/);
    expect(() =>
      assertCodexFundingModelReady({
        config: {
          paymentSource: "site-api-key",
          model: "gpt-5.6-luna",
          reasoning: "medium",
        },
        paymentSource,
      }),
    ).not.toThrow();
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

  it("does not carry a working directory into another project", () => {
    expect(
      effectiveNewAgentWorkingDirectory({
        projectId: "project-b",
        directoryProjectId: "project-a",
        directory: "/home/user/stuff",
        projectHome: "/home/user",
      }),
    ).toBe("/home/user");
    expect(
      effectiveNewAgentWorkingDirectory({
        projectId: "project-a",
        directoryProjectId: "project-a",
        directory: "/home/user/stuff",
        projectHome: "/home/user",
      }),
    ).toBe("/home/user/stuff");
  });

  it("distinguishes a missing working directory from a non-directory", async () => {
    await expect(
      assertAgentWorkingDirectory(
        { stat: jest.fn(async () => Promise.reject(new Error("ENOENT"))) },
        "/home/user/missing",
      ),
    ).rejects.toBeInstanceOf(MissingAgentWorkingDirectoryError);

    await expect(
      assertAgentWorkingDirectory(
        { stat: jest.fn(async () => ({ isDirectory: () => false })) },
        "/home/user/file",
      ),
    ).rejects.toThrow('Working directory "/home/user/file" is not a directory');
  });

  it("creates and revalidates a missing working directory", async () => {
    const mkdir = jest.fn(async () => undefined);
    const stat = jest.fn(async () => ({ isDirectory: () => true }));

    await createAgentWorkingDirectory({ mkdir, stat }, "/home/user/scratch2");

    expect(mkdir).toHaveBeenCalledWith("/home/user/scratch2", {
      recursive: true,
    });
    expect(stat).toHaveBeenCalledWith("/home/user/scratch2");
  });
});
