/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A terminal frame can live in any editor, not only in a .term file, so the
// accessor for its live terminal has to be on the base editor actions.  When
// it was only on the terminal editor's actions, the agent prompt for a
// terminal frame inside e.g. a notebook carried no session id at all.

import { BaseEditorActions } from "@cocalc/frontend/frame-editors/base-editor/actions-base";
import { fromJS } from "immutable";

describe("BaseEditorActions.get_terminal", () => {
  it("is available to every editor's actions", () => {
    expect(typeof (BaseEditorActions as any).prototype.get_terminal).toBe(
      "function",
    );
  });

  it("only reuses a shell from the selected thread scope", () => {
    const nodes = [
      {
        id: "second-agent",
        type: "terminal",
        "data-terminalScope": "thread-2",
      },
      { id: "legacy", type: "terminal" },
      { id: "first-agent", type: "terminal", "data-terminalScope": "thread-1" },
    ].map((node) => fromJS(node));
    const target = {
      _get_most_recent_active_frame_id: (filter) =>
        nodes.find(filter)?.get("id"),
    };
    const find = (scope?: string) =>
      (BaseEditorActions.prototype as any).getMostRecentShellId.call(
        target,
        undefined,
        undefined,
        scope,
      );
    expect(find("thread-1")).toBe("first-agent");
    expect(find("thread-2")).toBe("second-agent");
    expect(find("thread-3")).toBeUndefined();
    expect(find()).toBe("legacy");
  });

  it("creates a distinct scoped shell when another agent owns the recent terminal", async () => {
    const split = jest.fn(() => "new-terminal");
    const target = {
      getMostRecentShellId: jest.fn(() => undefined),
      split_frame: split,
    };
    await BaseEditorActions.prototype.terminal.call(
      target as any,
      "chat-frame",
      true,
      "/repo",
      "thread-2",
    );
    expect(target.getMostRecentShellId).toHaveBeenCalledWith(
      undefined,
      undefined,
      "thread-2",
    );
    expect(split).toHaveBeenCalledWith("col", "chat-frame", "terminal", {
      cwd: "/repo",
      "data-terminalScope": "thread-2",
    });
  });
});
