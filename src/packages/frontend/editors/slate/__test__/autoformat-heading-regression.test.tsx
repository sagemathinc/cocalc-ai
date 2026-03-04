import "../elements/types";

import { createEditor, Descendant, Transforms } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { slate_to_markdown } from "../slate-to-markdown";

test("autoformat heading prefix at line start does not duplicate trailing text", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text: "#foo b" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 0 });
  editor.insertText("#bar");
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toBe("\\#bar #foo b\n");
  expect(md).not.toContain("#foo b #foo b");
  expect(md).toContain("#bar");
  expect(md.indexOf("#foo b")).toBe(md.lastIndexOf("#foo b"));
});
