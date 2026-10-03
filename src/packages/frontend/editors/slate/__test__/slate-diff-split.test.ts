import { createEditor, Editor } from "slate";
import { markdown_to_slate } from "../markdown-to-slate";
import { slate_to_markdown } from "../slate-to-markdown";
import { slateDiff } from "../slate-diff";

// Slate builds the second half of a split text node only from the split
// operation's properties, so a split must carry all of that half's marks.
test("splitting a marked text node keeps the marks of both halves", () => {
  const editor = createEditor();
  editor.children = markdown_to_slate("**a b c**\n", false, {});
  const next = markdown_to_slate("**a b **c****\n", false, {});
  Editor.withoutNormalizing(editor, () => {
    for (const op of slateDiff(editor.children, next)) editor.apply(op);
  });
  // (Normalizing merges the two bold halves back into one.)
  expect(slate_to_markdown(editor.children, {})).toBe("**a b c**\n");
});
