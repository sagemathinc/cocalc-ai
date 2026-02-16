import "../elements/types";
import "../keyboard";

import React from "react";
import { createEditor, Range } from "slate";
import { withReact } from "../slate-react";
import { getHandler, IS_MACOS } from "../keyboard/register";
import { toCodeLines } from "../elements/code-block/utils";
import type { SearchHook } from "../search";

const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  focus: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  Search: React.createElement("div"),
  search: "",
};

test("first ctrl+a selects code block contents", () => {
  const editor = withReact(createEditor());
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("a\nb\nc") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 1 },
    focus: { path: [0, 1, 0], offset: 1 },
  };

  const handler = getHandler({
    key: "a",
    shiftKey: false,
    ctrlKey: !IS_MACOS,
    metaKey: IS_MACOS,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor: editor as any,
    extra: { actions: {}, id: "", search: EMPTY_SEARCH },
  });

  expect(editor.selection).toBeTruthy();
  expect(Range.isCollapsed(editor.selection!)).toBe(false);
  expect(editor.selection?.anchor.path[0]).toBe(0);
  expect(editor.selection?.focus.path[0]).toBe(0);
});
