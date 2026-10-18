/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { fromJS } from "immutable";
import {
  AgentSelectionReporter,
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

describe("AgentSelectionReporter: the route owns agent selection", () => {
  // Two agents (A, B) in one chat file; an optional artifact frame.
  const view = (
    chatThread: string,
    {
      active = "chat",
      artifact = false,
      second,
    }: {
      active?: string;
      artifact?: boolean;
      second?: string;
    } = {},
  ) =>
    fromJS({
      active_id: active,
      frame_tree: {
        type: "node",
        children: [
          {
            id: "chat",
            type: "chatroom",
            "data-selectedThreadKey": chatThread,
          },
          ...(second
            ? [
                {
                  id: "chat-2",
                  type: "chatroom",
                  "data-selectedThreadKey": second,
                },
              ]
            : []),
          ...(artifact ? [{ id: "artifact", type: "artifact" }] : []),
        ],
      },
    });
  let clock = 0;
  const reporter = () => new AgentSelectionReporter(() => clock);
  beforeEach(() => {
    clock = 1000;
  });

  it("click A, then B, then open an artifact: settles on B and never flips back", () => {
    const r = reporter();
    const reported: string[] = [];
    const change = (state: any, route: string) => {
      const thread = r.viewStateChanged(state, route);
      if (thread) reported.push(thread);
    };
    // Route: A. The chat shows A.
    r.requested("thread-A", view("thread-A"));
    // Route: B. Before the editor applies it, a late view-state update
    // still shows A (the old ping-pong trigger).
    r.requested("thread-B", view("thread-A"));
    change(view("thread-A"), "thread-B");
    change(view("thread-B"), "thread-B");
    // Opening an artifact focuses another frame and adds a stale chat frame
    // showing A: focus changes are never selections.
    change(
      view("thread-B", { artifact: true, active: "artifact" }),
      "thread-B",
    );
    change(
      view("thread-B", {
        artifact: true,
        active: "chat-2",
        second: "thread-A",
      }),
      "thread-B",
    );
    clock += 10_000;
    change(
      view("thread-B", {
        artifact: true,
        active: "chat-2",
        second: "thread-A",
      }),
      "thread-B",
    );
    expect(reported.filter((t) => t !== "thread-B")).toEqual([]);
  });

  it("a late write of the previous thread after a switch is not a selection", () => {
    const r = reporter();
    r.requested("thread-A", view("thread-A"));
    clock += 5000;
    r.requested("thread-B", view("thread-A"));
    clock += 50;
    expect(r.viewStateChanged(view("thread-B"), "thread-B")).toBe("thread-B");
    clock += 300;
    // Another writer sets the chat back to A: the old ping-pong.
    expect(r.viewStateChanged(view("thread-A"), "thread-B")).toBeUndefined();
    // Later, choosing A in the chat on purpose is a selection again.
    expect(r.viewStateChanged(view("thread-B"), "thread-B")).toBe("thread-B");
    clock += 2000;
    expect(r.viewStateChanged(view("thread-A"), "thread-B")).toBe("thread-A");
  });

  it("frames opening or gaining focus are never selections", () => {
    const r = reporter();
    r.requested("thread-B", view("thread-B"));
    clock += 10_000; // long after any switch
    expect(
      r.viewStateChanged(
        view("thread-B", { artifact: true, active: "artifact" }),
        "thread-B",
      ),
    ).toBeUndefined();
    // A second chat frame (showing another agent's thread) opens and
    // takes focus.
    expect(
      r.viewStateChanged(
        view("thread-B", { active: "chat-2", second: "thread-A" }),
        "thread-B",
      ),
    ).toBeUndefined();
  });

  it("reports the person picking another thread in the chat", () => {
    const r = reporter();
    r.requested("thread-A", view("thread-A"));
    clock += 100;
    expect(r.viewStateChanged(view("thread-X"), "thread-A")).toBe("thread-X");
  });

  it("an old route request does not block selections forever", () => {
    const r = reporter();
    r.requested("thread-B", view("thread-A")); // the echo never arrives
    expect(r.viewStateChanged(view("thread-C"), "thread-B")).toBeUndefined();
    clock += 5000;
    expect(r.viewStateChanged(view("thread-D"), "thread-B")).toBe("thread-D");
  });

  it("cuts off a runaway loop after three reports in two seconds", () => {
    const r = reporter();
    r.requested("thread-A", view("thread-A"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const threads = ["x1", "x2", "x3", "x4", "x5"];
      const reported = threads.map((t) => {
        clock += 100;
        return r.viewStateChanged(view(t), "thread-A");
      });
      expect(reported).toEqual(["x1", "x2", "x3", undefined, undefined]);
      clock += 3000;
      expect(r.viewStateChanged(view("x6"), "thread-A")).toBe("x6");
    } finally {
      warn.mockRestore();
    }
  });
});
