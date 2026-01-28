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

test("multiline paste always offers convert-to-rich-text option", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };

  const data = {
    getData: (type: string) => (type === "text/plain" ? "foo\nbar\n" : ""),
    items: [],
  };

  editor.insertData(data as any);

  const code = editor.children.find(
    (node: any) => node.type === "code_block",
  ) as any;
  expect(code).toBeTruthy();
  expect(getCodeBlockText(code)).toBe("foo\nbar\n");
  expect(code.markdownCandidate).toBe(true);
});

test("multiline paste preserves indentation in code blocks", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };

  const data = {
    getData: (type: string) =>
      type === "text/plain" ? "  indented\n\t\tmore\n" : "",
    items: [],
  };

  editor.insertData(data as any);

  const code = editor.children.find(
    (node: any) => node.type === "code_block",
  ) as any;
  expect(code).toBeTruthy();
  expect(getCodeBlockText(code)).toBe("  indented\n\t\tmore\n");
});

test("multiline paste inside code block preserves newlines", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    {
      type: "code_block",
      fence: true,
      info: "",
      children: [{ type: "code_line", children: [{ text: "def f():" }] }],
    },
  ] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0, 0], offset: 7 },
    focus: { path: [0, 0, 0], offset: 7 },
  };

  const data = {
    getData: (type: string) =>
      type === "text/plain" ? "\n    \"foo\"\n    print('hi')\n" : "",
    items: [],
  };

  editor.insertData(data as any);

  const code = editor.children[0] as any;
  expect(getCodeBlockText(code)).toBe(
    "def f():\n    \"foo\"\n    print('hi')\n",
  );
});
