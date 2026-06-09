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

    expect(actions.set_value).toHaveBeenCalledWith("new slate text", true);
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

    expect(actions.set_value).toHaveBeenCalledWith("foo", true);
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
