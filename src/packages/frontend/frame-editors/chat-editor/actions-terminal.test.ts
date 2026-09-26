/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { StructuredEditorActions } from "../base-editor/actions-structured";
import { Actions, chatTerminalWorkingDirectory } from "./actions";
import { fromJS } from "immutable";

describe("chatTerminalWorkingDirectory", () => {
  it("uses the selected agent thread working directory", () => {
    expect(
      chatTerminalWorkingDirectory("thread-1", {
        workingDirectory: " /home/user/repo ",
      }),
    ).toBe("/home/user/repo");
  });

  it("falls back when no selected thread or working directory is available", () => {
    expect(
      chatTerminalWorkingDirectory(undefined, {
        workingDirectory: "/home/user/repo",
      }),
    ).toBeUndefined();
    expect(chatTerminalWorkingDirectory("thread-1", {})).toBeUndefined();
  });
});

describe("chat editor terminal", () => {
  afterEach(() => jest.restoreAllMocks());

  it("redirects keyboard activation away from an off-thread shell", () => {
    const active = jest
      .spyOn(StructuredEditorActions.prototype, "set_active_id")
      .mockImplementation(() => {});
    const store = fromJS({
      local_view_state: {
        active_id: "chat",
        frame_tree: {
          id: "root",
          type: "node",
          children: [
            { id: "chat", type: "chatroom", "data-selectedThreadKey": "b" },
            { id: "old", type: "terminal", "data-terminalScope": "a" },
            { id: "legacy", type: "terminal" },
          ],
        },
      },
    });
    Actions.prototype.set_active_id.call({ store } as any, "old");
    expect(active).toHaveBeenLastCalledWith("chat", undefined);
    Actions.prototype.set_active_id.call({ store } as any, "legacy");
    expect(active).toHaveBeenLastCalledWith("legacy", undefined);
  });

  it("leaves an off-thread maximized shell when the selected thread changes", () => {
    const store: any = fromJS({
      local_view_state: {
        active_id: "old",
        full_id: "old",
        frame_tree: {
          id: "root",
          type: "node",
          children: [
            { id: "chat", type: "chatroom", "data-selectedThreadKey": "b" },
            { id: "old", type: "terminal", "data-terminalScope": "a" },
          ],
        },
      },
    });
    jest
      .spyOn(StructuredEditorActions.prototype, "set_frame_data")
      .mockImplementation(() => {});
    const target = {
      store,
      _get_tree: () => store.getIn(["local_view_state", "frame_tree"]),
      _get_active_id: () => "old",
      _get_frame_node: () => fromJS({ "data-terminalScope": "a" }),
      set_active_id: jest.fn(),
      unset_frame_full: jest.fn(),
    };
    Actions.prototype.set_frame_data.call(target as any, {
      id: "chat",
      selectedThreadKey: "b",
    });
    expect(target.set_active_id).toHaveBeenCalledWith("chat");
    expect(target.unset_frame_full).toHaveBeenCalled();
  });

  it("passes the selected thread working directory to the terminal frame", async () => {
    const terminal = jest
      .spyOn(StructuredEditorActions.prototype, "terminal")
      .mockResolvedValue();
    const target: any = {
      _get_frame_node: () => ({
        get: (key: string) =>
          key === "data-selectedThreadKey" ? "thread-1" : undefined,
      }),
      getChatActions: () => ({
        getCodexConfig: () => ({ workingDirectory: "/home/user/repo" }),
      }),
    };

    await Actions.prototype.terminal.call(target, "chat-frame", false);

    expect(terminal).toHaveBeenCalledWith(
      "chat-frame",
      false,
      "/home/user/repo",
      "thread-1",
    );
    terminal.mockRestore();
  });
});
