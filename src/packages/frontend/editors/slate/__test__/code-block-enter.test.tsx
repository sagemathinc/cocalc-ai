import "../elements/types";
import "../keyboard";

import React from "react";
import { createEditor } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { getHandler } from "../keyboard/register";
import { getCodeBlockText, toCodeLines } from "../elements/code-block/utils";
import type { SearchHook } from "../search";

const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  focus: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  Search: React.createElement("div"),
  search: "",
};

test("enter autoindents inside code blocks", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("  foo") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 0, 0], offset: 5 },
    focus: { path: [0, 0, 0], offset: 5 },
  };

  const handler = getHandler({
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor: editor as any,
    extra: { actions: {}, id: "", search: EMPTY_SEARCH },
  });

  expect(getCodeBlockText(editor.children[0] as any)).toBe("  foo\n  ");
  expect(editor.selection?.focus.path).toEqual([0, 1, 0]);
  expect(editor.selection?.focus.offset).toBe(2);
});
