import "../elements/types";

import { createEditor, Descendant, Transforms } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { withNormalize } from "../normalize";
import { withIsInline, withIsVoid } from "../plugins";
import { slate_to_markdown } from "../slate-to-markdown";

test("autoformat hashtag at paragraph start still works after heading-prefix guard", () => {
  const editor = withAutoFormat(
    withNormalize(withIsInline(withIsVoid(withReact(createEditor())))),
  );
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 0 });
  editor.insertText("#foo");
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toMatch(/^#foo/);
  expect(md).not.toMatch(/^\\#foo/);
});

test("autoformat hashtag before existing trailing words in same line", () => {
  const editor = withAutoFormat(
    withNormalize(withIsInline(withIsVoid(withReact(createEditor())))),
  );
  editor.children = [{ type: "paragraph", children: [{ text: "#x foo bar" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: "#x".length });
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("#x");
  expect(md).toContain("foo bar");
});
