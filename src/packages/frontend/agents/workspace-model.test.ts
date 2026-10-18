/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { fromJS } from "immutable";
import {
  agentWorkspaceKey,
  findWorkspaceAgentForThread,
  selectedChatThreadFromLocalViewState,
} from "./workspace-model";

function agent(id: string, path = "/agents.chat"): NamedAgent {
  return {
    account_id: "account",
    name: id,
    endpoint: { project_id: "project", agent_id: id },
    path,
    thread_id: `thread-${id}`,
    available: true,
    updated_at: new Date(0).toISOString(),
  };
}

it("uses project and chat path as the mounted workspace identity", () => {
  expect(agentWorkspaceKey(agent("one"))).toBe(agentWorkspaceKey(agent("two")));
  expect(agentWorkspaceKey(agent("three", "/other.chat"))).not.toBe(
    agentWorkspaceKey(agent("one")),
  );
});

it("resolves a registered agent by workspace and selected thread", () => {
  const agents = [agent("one"), agent("two"), agent("other", "/other.chat")];
  expect(
    findWorkspaceAgentForThread(agents, "project", "/agents.chat", "thread-two")
      ?.name,
  ).toBe("two");
  expect(
    findWorkspaceAgentForThread(
      agents,
      "project",
      "/agents.chat",
      "thread-missing",
    ),
  ).toBeUndefined();
});

it("reads the selected thread from the active chat frame", () => {
  const localViewState = fromJS({
    active_id: "chat-two",
    frame_tree: {
      type: "node",
      children: [
        {
          id: "chat-one",
          type: "chatroom",
          "data-selectedThreadKey": "thread-one",
        },
        {
          id: "chat-two",
          type: "chatroom",
          "data-selectedThreadKey": "thread-two",
        },
      ],
    },
  });
  expect(selectedChatThreadFromLocalViewState(localViewState)).toBe(
    "thread-two",
  );
});

it("falls back to a chat frame when an artifact frame is active", () => {
  const localViewState = fromJS({
    active_id: "terminal",
    frame_tree: {
      type: "node",
      children: [
        { id: "terminal", type: "terminal" },
        {
          id: "chat",
          type: "chatroom",
          "data-selectedThreadKey": "thread-one",
        },
      ],
    },
  });
  expect(selectedChatThreadFromLocalViewState(localViewState)).toBe(
    "thread-one",
  );
});
