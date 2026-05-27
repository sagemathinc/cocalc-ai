/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sendGitCommitAgentTurn } from "../git-commit-agent-turn";
import { getDefaultNewThreadSetup } from "../chatroom-thread-panel";

function createActions({
  metadata,
}: {
  metadata?: Record<string, unknown>;
} = {}) {
  return {
    getThreadMetadata: jest.fn(() => metadata),
    getMessagesInThread: jest.fn(() => [{ message_id: "last-message" }]),
    getMessageByDate: jest.fn(() => ({ thread_id: "created-thread" })),
    sendChat: jest.fn(() => "2026-05-26T00:00:00.000Z"),
  } as any;
}

describe("sendGitCommitAgentTurn", () => {
  it("sends into an existing Codex thread", () => {
    const actions = createActions({
      metadata: {
        agent_kind: "acp",
        acp_config: { model: "gpt-5.4", workingDirectory: "/home/user/src" },
      },
    });

    const result = sendGitCommitAgentTurn({
      actions,
      prompt: "Set up this repository.",
      targetThreadKey: "thread-1",
      defaultNewThreadSetup: getDefaultNewThreadSetup(),
      workingDirectory: "/home/user/project",
    });

    expect(result).toEqual({
      mode: "existing",
      threadKey: "thread-1",
      timestamp: "2026-05-26T00:00:00.000Z",
    });
    expect(actions.sendChat).toHaveBeenCalledWith({
      extraInput: "Set up this repository.",
      reply_thread_id: "thread-1",
      parent_message_id: "last-message",
      preserveSelectedThread: true,
    });
  });

  it("creates a new Codex thread when the source thread is human", () => {
    const actions = createActions({
      metadata: {
        agent_kind: "none",
      },
    });
    const setup = {
      ...getDefaultNewThreadSetup(),
      title: "",
      color: "#abcdef",
      icon: "terminal",
      codexConfig: {
        ...getDefaultNewThreadSetup().codexConfig,
        model: "gpt-5.4",
        sessionMode: "workspace-write" as const,
      },
    };

    const result = sendGitCommitAgentTurn({
      actions,
      prompt: "Set up this repository.",
      targetThreadKey: "human-thread",
      defaultNewThreadSetup: setup,
      title: "Set up git repository",
      workingDirectory: "/home/user/project",
    });

    expect(result).toEqual({
      mode: "created",
      threadKey: "created-thread",
      timestamp: "2026-05-26T00:00:00.000Z",
    });
    expect(actions.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        extraInput: "Set up this repository.",
        name: "Set up git repository",
        threadAgent: expect.objectContaining({
          mode: "codex",
          model: "gpt-5.4",
          codexConfig: expect.objectContaining({
            model: "gpt-5.4",
            sessionMode: "workspace-write",
            allowWrite: true,
            workingDirectory: "/home/user/project",
          }),
        }),
        threadAppearance: {
          color: "#abcdef",
          icon: "terminal",
          image: undefined,
        },
      }),
    );
    expect(actions.sendChat.mock.calls[0][0].reply_thread_id).toBeUndefined();
  });
});
