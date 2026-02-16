import "../elements/types";
import "../keyboard";

import { createEditor } from "slate";
import { withReact } from "../slate-react";
import { getHandler } from "../keyboard/register";
import { slate_to_markdown } from "../slate-to-markdown";
import type { SearchHook } from "../search";

const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  focus: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  Search: undefined as any,
  search: "",
};

test("shift+enter sends latest markdown even when cache is stale", () => {
  const editor = withReact(createEditor()) as any;
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "hello" }],
    },
  ];
  editor.markdownValue = "";
  editor._hasUnsavedChanges = false;
  editor.resetHasUnsavedChanges = () => {
    editor._hasUnsavedChanges = editor.children;
  };
  editor.hasUnsavedChanges = () => {
    if (editor._hasUnsavedChanges === false) return false;
    return editor._hasUnsavedChanges !== editor.children;
  };
  editor.getMarkdownValue = () => {
    if (editor.markdownValue != null && !editor.hasUnsavedChanges()) {
      return editor.markdownValue;
    }
    editor.markdownValue = slate_to_markdown(editor.children);
    return editor.markdownValue;
  };

  let sent = "";
  const handler = getHandler({
    key: "Enter",
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor,
    extra: { actions: { shiftEnter: (value) => (sent = value) }, id: "", search: EMPTY_SEARCH },
  });

  expect(sent.trim()).toBe("hello");
});
