import { createEditor } from "slate";

import { insertParagraphAtGap } from "../gap-cursor";
import type { Paragraph } from "../elements/paragraph";

const paragraph = (text: string): Paragraph => ({
  type: "paragraph",
  blank: false,
  children: [{ text }],
});

test("insertParagraphAtGap clamps stale paths to document end", () => {
  const editor = createEditor();
  editor.children = [paragraph("start")];

  insertParagraphAtGap(editor as any, { path: [10], side: "after" });

  expect(editor.children).toHaveLength(2);
  expect(editor.children[1]).toMatchObject({
    type: "paragraph",
    children: [{ text: "" }],
  });
});
