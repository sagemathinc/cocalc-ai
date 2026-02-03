import "../elements/types";
import "../keyboard";

import React from "react";
import { createEditor } from "slate";
import { withReact } from "../slate-react";
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

test("ctrl+; splits code blocks even when key reports as Semicolon code", () => {
  const editor = withReact(createEditor());
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("a\nb\nc") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 0 },
    focus: { path: [0, 1, 0], offset: 0 },
  };

  const handler = getHandler({
    key: "Dead",
    code: "Semicolon",
    shiftKey: false,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor: editor as any,
    extra: { actions: {}, id: "", search: EMPTY_SEARCH },
  });

  expect(editor.children).toHaveLength(2);
  expect(getCodeBlockText(editor.children[0] as any)).toBe("a");
  expect(getCodeBlockText(editor.children[1] as any)).toBe("b\nc");
});
