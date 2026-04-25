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
