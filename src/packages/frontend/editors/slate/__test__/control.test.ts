import "../elements/types";

import { createEditor, type Descendant } from "slate";

import { scrollToHeading } from "../control";
import { ReactEditor } from "../slate-react";
import type { SlateEditor } from "../types";

test("scrollToHeading moves Slate selection to the target heading", async () => {
  const editor = createEditor() as SlateEditor;
  editor.children = [
    { type: "paragraph", children: [{ text: "old selection" }] },
    { type: "heading", level: 1, children: [{ text: "Target" }] },
  ] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0], offset: 3 },
    focus: { path: [0, 0], offset: 3 },
  };
  const scrollIntoView = jest.fn();
  const toDOMNode = jest
    .spyOn(ReactEditor, "toDOMNode")
    .mockReturnValue({ scrollIntoView } as any);
  const focus = jest.spyOn(ReactEditor, "focus").mockImplementation(() => {});

  try {
    await scrollToHeading(editor as ReactEditor, 0);
  } finally {
    toDOMNode.mockRestore();
    focus.mockRestore();
  }

  expect(editor.selection).toEqual({
    anchor: { path: [1, 0], offset: 0 },
    focus: { path: [1, 0], offset: 0 },
  });
  expect(scrollIntoView).toHaveBeenCalledWith(true);
});
