/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { showValueInEditor } from "../cell-editor-value";

// An editor whose change event saves synchronously, as the debounced save
// does once its maximum wait has passed (a throttled background tab).
function editorThatSavesOnChange(initial: string) {
  let text = initial;
  const lastRemote = { current: initial as string | null };
  const saves: { base: string | null; value: string }[] = [];
  const editor = {
    getValue: () => text,
    setValueNoJump: (value: string) => {
      text = value;
      // the code cell's save: only if the text differs from the baseline
      if (text !== lastRemote.current) {
        saves.push({ base: lastRemote.current, value: text });
        lastRemote.current = text;
      }
    },
  };
  return { editor, lastRemote, saves };
}

describe("showing a value in a code cell's editor", () => {
  it("is never saved as an edit of an older baseline", () => {
    const { editor, lastRemote, saves } = editorThatSavesOnChange("x = 1\nw1");
    showValueInEditor({ editor, lastRemote, shown: "x = 1\nw1 w2 w3 w4" });
    expect(saves).toEqual([]);
    expect(lastRemote.current).toBe("x = 1\nw1 w2 w3 w4");
    expect(editor.getValue()).toBe("x = 1\nw1 w2 w3 w4");
  });

  it("keeps unsaved local edits as edits of the new value", () => {
    const { editor, lastRemote, saves } = editorThatSavesOnChange("a\nmine");
    showValueInEditor({
      editor,
      lastRemote,
      shown: "a b\nmine",
      baseline: "a b\n",
    });
    expect(saves).toEqual([{ base: "a b\n", value: "a b\nmine" }]);
  });

  it("does nothing to an editor that already shows the value", () => {
    const { editor, lastRemote, saves } = editorThatSavesOnChange("same");
    const set = jest.spyOn(editor, "setValueNoJump");
    showValueInEditor({ editor, lastRemote, shown: "same" });
    expect(set).not.toHaveBeenCalled();
    expect(saves).toEqual([]);
  });
});
