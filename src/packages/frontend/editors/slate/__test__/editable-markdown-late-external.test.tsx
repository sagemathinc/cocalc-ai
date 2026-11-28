/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import { Transforms } from "slate";
import { EditableMarkdown } from "../editable-markdown";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

// A value-backed editor (like a notebook cell's) whose onChange for an
// external value arrives after the sync-caused flag was cleared, as React
// may deliver it a render later under a burst of external updates.
describe("a late onChange for an external value", () => {
  function setup() {
    let editor: any = null;
    const setValue = jest.fn();
    const dirtyRef = { current: false };
    const slateChanges: { syncCausedUpdate: boolean }[] = [];
    const view = (value: string) => (
      <EditableMarkdown
        value={value}
        actions={
          {
            set_value: setValue,
            registerSlateEditor: (_id: string, ed: any) => {
              editor = ed;
            },
          } as any
        }
        dirtyRef={dirtyRef}
        onSlateChange={(_value, info) => slateChanges.push(info)}
        saveDebounceMs={10}
        is_current
        enableUpload={false}
        minimal
        hidePath
        disableWindowing
        noVfill
        showEditBar={false}
        height="auto"
      />
    );
    const result = render(view("First paragraph.\n\nSecond paragraph."));
    return {
      ...result,
      view,
      setValue,
      dirtyRef,
      slateChanges,
      getEditor: () => editor,
    };
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

  it("is not taken for an edit: nothing is marked dirty or saved", async () => {
    const { rerender, view, setValue, dirtyRef, slateChanges, getEditor } =
      setup();
    await settle();
    // a collaborator's change, applied externally
    rerender(view("First paragraph.\n\nSecond paragraph, changed elsewhere."));
    await settle();
    setValue.mockClear();
    dirtyRef.current = false;
    const editor = getEditor();
    expect(editor).not.toBeNull();
    // the late callback: the flag is already clear, no operation of its own
    await act(async () => {
      editor.syncCausedUpdate = false;
      editor.onChange();
    });
    await settle();
    expect(dirtyRef.current).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    // and observers are told it was sync-caused
    expect(slateChanges.at(-1)?.syncCausedUpdate).toBe(true);
  });

  it("is not taken for an edit after a direct replacement either", async () => {
    // From one block to many in an unfocused editor: replaced directly, and
    // the new tree becomes the editor's children only on the next render.
    const { rerender, view, setValue, dirtyRef, getEditor } = setup();
    rerender(view("One paragraph."));
    await settle();
    const many = Array.from({ length: 45 }, (_, i) => `Paragraph ${i}.`).join(
      "\n\n",
    );
    rerender(view(many));
    await settle();
    setValue.mockClear();
    dirtyRef.current = false;
    const editor = getEditor();
    expect(editor.children.length).toBeGreaterThanOrEqual(45);
    await act(async () => {
      editor.syncCausedUpdate = false;
      editor.onChange();
    });
    await settle();
    expect(dirtyRef.current).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("still takes a local edit after an external value for an edit", async () => {
    const { rerender, view, setValue, dirtyRef, getEditor } = setup();
    await settle();
    rerender(view("First paragraph.\n\nSecond paragraph, changed elsewhere."));
    await settle();
    setValue.mockClear();
    dirtyRef.current = false;
    const editor = getEditor();
    await act(async () => {
      editor.syncCausedUpdate = false;
      Transforms.insertText(editor, " typed here", {
        at: { path: [0, 0], offset: "First paragraph.".length },
      });
    });
    await settle();
    expect(dirtyRef.current).toBe(true);
    expect(setValue).toHaveBeenCalled();
    expect(setValue.mock.calls.at(-1)[0]).toContain("typed here");
  });
});
