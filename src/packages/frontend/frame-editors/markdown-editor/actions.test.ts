import { Actions } from "./actions";

describe("markdown editor Actions", () => {
  it("flushes active Slate markdown instead of stale CodeMirror text", () => {
    const actions: any = Object.create(Actions.prototype);
    actions._get_active_id = jest.fn(() => "slate-frame");
    actions._get_frame_type = jest.fn(() => "slate");
    actions.getBlockEditorControl = jest.fn(() => ({
      getMarkdown: () => "new slate text",
    }));
    actions.set_value = jest.fn();

    actions.set_syncstring_to_codemirror(undefined, true);

    expect(actions.set_value).toHaveBeenCalledWith(
      "new slate text",
      true,
      "slate",
    );
  });

  it("flushes Slate markdown before opening the CodeMirror split", () => {
    const actions: any = Object.create(Actions.prototype);
    const calls: string[] = [];
    actions.getBlockEditorControl = jest.fn(() => ({
      getMarkdown: () => "foo",
      getMarkdownPositionForSelection: () => ({ line: 0, ch: 3 }),
    }));
    actions.set_value = jest.fn(() => calls.push("set_value"));
    actions.programmatically_goto_line = jest.fn(() => {
      calls.push("programmatically_goto_line");
      return Promise.resolve();
    });
    actions.show_recently_focused_frame_of_type = jest.fn(() => "cm-frame");
    actions.set_active_id = jest.fn();

    actions.sync_slate_to_cm("slate-frame");

    expect(actions.set_value).toHaveBeenCalledWith("foo", true, "slate");
    expect(actions.programmatically_goto_line).toHaveBeenCalledWith(
      1,
      true,
      true,
      undefined,
      3,
    );
    expect(actions.set_active_id).toHaveBeenCalledWith("cm-frame", true);
    expect(calls).toEqual(["set_value", "programmatically_goto_line"]);
  });

  it("flushes CodeMirror markdown before opening the Slate split", async () => {
    const actions: any = Object.create(Actions.prototype);
    const calls: string[] = [];
    actions._cm = {
      "cm-frame": {
        getValue: () => "new codemirror text",
        getDoc: () => ({
          getCursor: () => ({ line: 0, ch: 4 }),
        }),
      },
    };
    actions.set_value = jest.fn(() => calls.push("set_value"));
    actions.show_focused_frame_of_type = jest.fn(() => {
      calls.push("show_focused_frame_of_type");
      return "slate-frame";
    });
    actions.getBlockEditorControl = jest.fn(() => ({
      setSelectionFromMarkdownPosition: jest.fn(() => true),
    }));
    actions.set_active_id = jest.fn();

    await actions.sync_cm_to_slate("cm-frame", actions);

    expect(actions.set_value).toHaveBeenCalledWith(
      "new codemirror text",
      true,
      "cm",
    );
    expect(actions.show_focused_frame_of_type).toHaveBeenCalledWith("slate");
    expect(actions.set_active_id).toHaveBeenCalledWith("slate-frame", true);
    expect(calls).toEqual(["set_value", "show_focused_frame_of_type"]);
  });

  it("uses the live CodeMirror instance passed by the key handler", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions._cm = {
      "cm-frame": {
        getValue: () => "stale registered text",
        getDoc: () => ({
          getCursor: () => ({ line: 0, ch: 0 }),
        }),
      },
    };
    const liveCm = {
      getValue: () => "live codemirror text",
      getDoc: () => ({
        getCursor: () => ({ line: 0, ch: 5 }),
      }),
    };
    actions.set_value = jest.fn();
    actions.show_focused_frame_of_type = jest.fn(() => "slate-frame");
    const setSelectionFromMarkdownPosition = jest.fn(() => true);
    actions.getBlockEditorControl = jest.fn(() => ({
      setSelectionFromMarkdownPosition,
    }));
    actions.set_active_id = jest.fn();

    await actions.sync_cm_to_slate("cm-frame", actions, liveCm);

    expect(actions.set_value).toHaveBeenCalledWith(
      "live codemirror text",
      true,
      "cm",
    );
    expect(setSelectionFromMarkdownPosition).toHaveBeenCalledWith({
      line: 0,
      ch: 5,
    });
  });

  it("waits for a newly opened Slate frame to register before selecting", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions._cm = {
      "cm-frame": {
        getValue: () => "foo",
        getDoc: () => ({
          getCursor: () => ({ line: 0, ch: 3 }),
        }),
      },
    };
    actions.set_value = jest.fn();
    actions.show_focused_frame_of_type = jest.fn(() => "slate-frame");
    const setSelectionFromMarkdownPosition = jest.fn(() => true);
    actions.getBlockEditorControl = jest
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        setSelectionFromMarkdownPosition,
      });
    actions.getSlateEditor = jest.fn(() => undefined);
    actions.set_active_id = jest.fn();

    await actions.sync_cm_to_slate("cm-frame", actions);

    expect(actions.getBlockEditorControl).toHaveBeenCalledTimes(3);
    expect(setSelectionFromMarkdownPosition).toHaveBeenCalledWith({
      line: 0,
      ch: 3,
    });
    expect(actions.set_active_id).toHaveBeenCalledWith("slate-frame", true);
  });

  it("restores the last focused Slate block on refocus instead of jumping to block 0", () => {
    const actions: any = Object.create(Actions.prototype);
    const restoreFocusBlock = jest.fn(() => true);
    const focusBlock = jest.fn();
    actions._get_active_id = jest.fn(() => "slate-frame");
    actions._get_frame_type = jest.fn(() => "slate");
    actions.getBlockEditorControl = jest.fn(() => ({
      getFocusedIndex: () => null,
      getLastFocusedIndex: () => 12,
      restoreFocusBlock,
      focusBlock,
    }));

    actions.focus(undefined);

    expect(restoreFocusBlock).toHaveBeenCalledWith(12);
    expect(focusBlock).not.toHaveBeenCalled();
  });
});
