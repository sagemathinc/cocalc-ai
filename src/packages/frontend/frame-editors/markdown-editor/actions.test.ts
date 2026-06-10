import { Actions } from "./actions";

describe("markdown editor Actions", () => {
  it("flushes active Slate markdown instead of stale CodeMirror text", () => {
    const actions: any = Object.create(Actions.prototype);
    actions._get_active_id = jest.fn(() => "slate-frame");
    actions._get_frame_type = jest.fn(() => "slate");
    actions.getSlateEditor = jest.fn(() => ({
      getMarkdownValue: () => "new slate text",
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
    actions.getSlateEditor = jest.fn(() => ({
      getMarkdownValue: () => "foo",
      selection: null,
    }));
    actions.set_value = jest.fn();

    actions.sync_slate_to_cm("slate-frame");

    expect(actions.set_value).toHaveBeenCalledWith("foo", true, "slate");
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
    actions.getSlateEditor = jest.fn(() => undefined);

    await actions.sync_cm_to_slate("cm-frame", actions);

    expect(actions.set_value).toHaveBeenCalledWith(
      "new codemirror text",
      true,
      "cm",
    );
    expect(actions.show_focused_frame_of_type).toHaveBeenCalledWith("slate");
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
    actions.getSlateEditor = jest.fn(() => undefined);

    await actions.sync_cm_to_slate("cm-frame", actions, liveCm);

    expect(actions.set_value).toHaveBeenCalledWith(
      "live codemirror text",
      true,
      "cm",
    );
  });

  it("waits for a newly opened Slate frame to register", async () => {
    const actions: any = Object.create(Actions.prototype);
    const editor = { getMarkdownValue: () => "foo" };
    actions.getSlateEditor = jest
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(editor);

    const result = await actions.waitForSlateEditor("slate-frame");

    expect(result).toBe(editor);
    expect(actions.getSlateEditor).toHaveBeenCalledTimes(3);
  });
});
