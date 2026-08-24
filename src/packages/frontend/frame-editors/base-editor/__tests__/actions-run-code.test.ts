/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { BaseEditorActions } from "../actions-base";
import { getStudentProjectFunctionality } from "@cocalc/frontend/course/configuration/customize-student-project-functionality";

jest.mock(
  "@cocalc/frontend/course/configuration/customize-student-project-functionality",
  () => ({ getStudentProjectFunctionality: jest.fn(() => ({})) }),
);

const studentProjectFunctionality =
  getStudentProjectFunctionality as unknown as jest.Mock;

beforeEach(() => {
  studentProjectFunctionality.mockReturnValue({});
});

function terminalMock() {
  return { conn_write: jest.fn() };
}

function runTarget(overrides: any = {}) {
  return {
    path: "dir/a.py",
    save: jest.fn(async () => {}),
    isClosed: () => false,
    _syncstring: { has_unsaved_changes: () => false },
    getRunTerminalId: jest.fn(() => "term-1"),
    split_frame: jest.fn(() => "term-new"),
    unset_frame_full: jest.fn(),
    set_active_id: jest.fn(),
    focus: jest.fn(),
    _get_active_id: jest.fn(() => "cm-1"),
    waitForTerminal: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe("BaseEditorActions.run_code", () => {
  it("saves the file, then sends the run command to the terminal", async () => {
    const terminal = terminalMock();
    const target: any = runTarget({
      waitForTerminal: jest.fn(async () => terminal),
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.save).toHaveBeenCalledWith(true);
    // \x05\x15 = Ctrl-E Ctrl-U, i.e. clear whatever is at the prompt.
    expect(terminal.conn_write).toHaveBeenCalledWith(
      "\x05\x15cd -- \"$HOME\"/'dir' && python3 'a.py'\n",
    );
  });

  it("focuses the terminal it runs in", async () => {
    const target: any = runTarget({
      waitForTerminal: jest.fn(async () => terminalMock()),
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.unset_frame_full).toHaveBeenCalled();
    expect(target.set_active_id).toHaveBeenCalledWith("term-1");
  });

  it("keeps the keyboard in the editor when asked to (shift+enter)", async () => {
    // The user is in the middle of editing: run, but let them keep typing.
    const target: any = runTarget({
      getRunTerminalId: jest.fn(() => undefined),
      waitForTerminal: jest.fn(async () => terminalMock()),
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1", undefined, {
      keepFocus: true,
    });

    // the new terminal frame is created without stealing focus ...
    expect(target.split_frame).toHaveBeenCalledWith(
      "col",
      "cm-1",
      "terminal",
      undefined,
      undefined,
      true,
    );
    // ... and the editor frame stays the active, focused one.
    expect(target.set_active_id).toHaveBeenCalledWith("cm-1");
    expect(target.set_active_id).not.toHaveBeenCalledWith("term-new");
    expect(target.focus).toHaveBeenCalledWith("cm-1");
  });

  it("reuses an existing terminal instead of splitting a new frame", async () => {
    const target: any = runTarget({
      waitForTerminal: jest.fn(async () => terminalMock()),
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.split_frame).not.toHaveBeenCalled();
  });

  it("splits off a terminal frame when there is none yet", async () => {
    const terminal = terminalMock();
    const target: any = runTarget({
      getRunTerminalId: jest.fn(() => undefined),
      waitForTerminal: jest.fn(async () => terminal),
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.split_frame).toHaveBeenCalledWith(
      "col",
      "cm-1",
      "terminal",
      undefined,
      undefined,
      undefined,
    );
    expect(target.waitForTerminal).toHaveBeenCalledWith("term-new");
    expect(terminal.conn_write).toHaveBeenCalled();
  });

  it("runs the file the frame shows, not the file of the frame tree", async () => {
    // A cm subframe can edit another file than the outer editor.
    const terminal = terminalMock();
    const target: any = runTarget({
      path: "outer.tex",
      waitForTerminal: jest.fn(async () => terminal),
    });
    const documentActions: any = {
      path: "sub/inner.py",
      save: jest.fn(async () => {}),
      isClosed: () => false,
      _syncstring: { has_unsaved_changes: () => false },
    };

    await BaseEditorActions.prototype.run_code.call(
      target,
      "cm-1",
      documentActions,
    );

    // the subfile is what gets saved and run ...
    expect(documentActions.save).toHaveBeenCalledWith(true);
    expect(target.save).not.toHaveBeenCalled();
    expect(terminal.conn_write).toHaveBeenCalledWith(
      "\x05\x15cd -- \"$HOME\"/'sub' && python3 'inner.py'\n",
    );
    // ... but the frames belong to the outer frame tree.
    expect(target.set_active_id).toHaveBeenCalledWith("term-1");
  });

  it("does nothing at all for a file it cannot run", async () => {
    const target: any = runTarget({ path: "dir/a.txt" });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.save).not.toHaveBeenCalled();
    expect(target.split_frame).not.toHaveBeenCalled();
    expect(target.waitForTerminal).not.toHaveBeenCalled();
  });

  it("does not run stale contents when saving to disk failed", async () => {
    // save() reports the error itself and returns normally, so the only sign
    // that the draft is not on disk is that it still has unsaved changes.
    const target: any = runTarget({
      _syncstring: { has_unsaved_changes: () => true },
    });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.save).toHaveBeenCalled();
    expect(target.getRunTerminalId).not.toHaveBeenCalled();
    expect(target.waitForTerminal).not.toHaveBeenCalled();
  });

  it("gives up if the editor was closed while saving", async () => {
    const target: any = runTarget({ isClosed: () => true });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.getRunTerminalId).not.toHaveBeenCalled();
  });

  it("does not run a read-only preview, even when invoked directly", async () => {
    // A preview has no syncstring, so save() is a no-op and the unsaved-check
    // has nothing to report -- and shift+enter calls this without going
    // through the (hidden) button.
    const target: any = runTarget({ readOnlyPreview: true, _syncstring: null });

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.save).not.toHaveBeenCalled();
    expect(target.split_frame).not.toHaveBeenCalled();
    expect(target.waitForTerminal).not.toHaveBeenCalled();
  });

  it("does not run a subframe whose document is a read-only preview", async () => {
    const target: any = runTarget({ path: "outer.py" });
    const documentActions: any = {
      path: "sub/inner.py",
      readOnlyPreview: true,
      save: jest.fn(async () => {}),
      isClosed: () => false,
      _syncstring: null,
    };

    await BaseEditorActions.prototype.run_code.call(
      target,
      "cm-1",
      documentActions,
    );

    expect(documentActions.save).not.toHaveBeenCalled();
    expect(target.split_frame).not.toHaveBeenCalled();
  });

  it("does not open a terminal when terminals are disabled for students", async () => {
    studentProjectFunctionality.mockReturnValue({ disableTerminals: true });
    const target: any = runTarget();

    await BaseEditorActions.prototype.run_code.call(target, "cm-1");

    expect(target.save).not.toHaveBeenCalled();
    expect(target.split_frame).not.toHaveBeenCalled();
  });
});

describe("BaseEditorActions.getRunTerminalId", () => {
  function idOf(nodes: { [id: string]: any }): string | undefined {
    const target: any = {
      _get_most_recent_active_frame_id: (f: Function) => {
        for (const id in nodes) {
          if (f(nodes[id])) {
            return id;
          }
        }
        return undefined;
      },
    };
    return (BaseEditorActions as any).prototype.getRunTerminalId.call(target);
  }

  it("skips REPL terminals created by the Shell command", () => {
    // "python3 foo.py" typed into a python REPL is just a syntax error, so a
    // terminal with a command set must never be picked.
    expect(
      idOf({
        "term-repl": fromJS({ type: "terminal", command: "python3" }),
        "term-plain": fromJS({ type: "terminal" }),
      }),
    ).toBe("term-plain");
  });

  it("ignores frames that are not terminals", () => {
    expect(
      idOf({
        "cm-1": fromJS({ type: "cm" }),
        "term-plain": fromJS({ type: "terminal" }),
      }),
    ).toBe("term-plain");
  });

  it("is undefined when only REPL terminals are open", () => {
    expect(
      idOf({ "term-repl": fromJS({ type: "terminal", command: "sage" }) }),
    ).toBe(undefined);
  });
});

describe("BaseEditorActions.waitForTerminal", () => {
  it("stops waiting when that terminal frame is closed again", async () => {
    // Otherwise a frame the user closes right away leaves us spinning for the
    // full timeout.
    const target: any = {
      isClosed: () => false,
      terminals: { get: () => undefined },
      _get_frame_node: () => undefined,
    };

    const terminal = await (
      BaseEditorActions as any
    ).prototype.waitForTerminal.call(target, "term-1");

    expect(terminal).toBe(undefined);
  });

  it("returns a terminal that is already mounted without waiting", async () => {
    const t = terminalMock();
    const target: any = {
      isClosed: () => false,
      terminals: { get: () => t },
      _get_frame_node: () => fromJS({ type: "terminal" }),
    };

    expect(
      await (BaseEditorActions as any).prototype.waitForTerminal.call(
        target,
        "term-1",
      ),
    ).toBe(t);
  });
});
