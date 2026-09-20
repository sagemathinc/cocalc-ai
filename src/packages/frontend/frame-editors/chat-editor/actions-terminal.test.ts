/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { StructuredEditorActions } from "../base-editor/actions-structured";
import { Actions, chatTerminalWorkingDirectory } from "./actions";

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
    );
    terminal.mockRestore();
  });
});
