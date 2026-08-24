/** @jest-environment jsdom */
/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// shift+enter in a code file: there is nothing to build, so it runs the file
// in a terminal -- the same thing the Run button in the title bar does.

import { Map } from "immutable";

jest.mock("../generic/client", () => ({
  get_editor_settings: () => Map({ show_exec_warning: true }),
  get_default_font_size: () => 14,
}));

import { cm_options } from "./cm-options";

const EDITOR_ACTIONS = { path: "sub/inner.py" };

function shiftEnter(filename: string, frame_tree_actions: any) {
  const opts = cm_options(
    filename,
    Map({ theme: "default" }) as any,
    [],
    EDITOR_ACTIONS,
    frame_tree_actions,
    "frame-1",
  );
  return opts.extraKeys["Shift-Enter"];
}

describe("shift+enter in a CodeMirror frame", () => {
  it("runs a code file that has no build", () => {
    const actions = { run_code: jest.fn(), set_error: jest.fn() };
    shiftEnter("a.py", actions)();
    // the second argument is the file the frame shows, which for a subframe
    // is not the file of the frame tree.
    expect(actions.run_code).toHaveBeenCalledWith("frame-1", EDITOR_ACTIONS, {
      keepFocus: true,
    });
    expect(actions.set_error).not.toHaveBeenCalled();
  });

  it("still builds when the editor has a build action", () => {
    const actions = {
      build: jest.fn(),
      run_code: jest.fn(),
      set_error: jest.fn(),
    };
    shiftEnter("a.py", actions)();
    expect(actions.build).toHaveBeenCalledWith("frame-1");
    expect(actions.run_code).not.toHaveBeenCalled();
  });

  it("keeps the 'use a notebook' hint for files it cannot run", () => {
    const actions = { run_code: jest.fn(), set_error: jest.fn() };
    shiftEnter("a.txt", actions)();
    expect(actions.run_code).not.toHaveBeenCalled();
    expect(actions.set_error).toHaveBeenCalled();
  });
});
