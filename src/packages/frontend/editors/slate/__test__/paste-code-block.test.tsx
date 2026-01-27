import "../elements/types";

import { createEditor, Descendant } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { getCodeBlockText } from "../elements/code-block/utils";

test("multiline paste inserts a code block with markdown hint", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };

  const data = {
    getData: (type: string) => (type === "text/plain" ? "- a\n- b\n" : ""),
    items: [],
  };

  editor.insertData(data as any);

  const code = editor.children.find(
    (node: any) => node.type === "code_block",
  ) as any;
  expect(code).toBeTruthy();
  expect(getCodeBlockText(code)).toBe("- a\n- b\n");
  expect(code.markdownCandidate).toBe(true);
});
