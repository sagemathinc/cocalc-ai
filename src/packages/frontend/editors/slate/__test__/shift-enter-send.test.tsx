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

test("shift+enter preserves cached markdown when editor is clean", () => {
  const editor = withReact(createEditor()) as any;
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "hello" }],
    },
  ];
  editor.markdownValue = "original\n\nsource";
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
    extra: {
      actions: { shiftEnter: (value) => (sent = value) },
      id: "",
      search: EMPTY_SEARCH,
    },
  });

  expect(sent).toBe("original\n\nsource");
});

test("shift+enter sends latest markdown when editor is dirty", () => {
  const editor = withReact(createEditor()) as any;
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "hello" }],
    },
  ];
  editor.markdownValue = "";
  editor._hasUnsavedChanges = {};
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
    extra: {
      actions: { shiftEnter: (value) => (sent = value) },
      id: "",
      search: EMPTY_SEARCH,
    },
  });

  expect(sent.trim()).toBe("hello");
});

test("command+enter preserves cached markdown when editor is clean", () => {
  const editor = withReact(createEditor()) as any;
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "hello" }],
    },
  ];
  editor.selection = {
    anchor: { path: [0, 0], offset: 5 },
    focus: { path: [0, 0], offset: 5 },
  };
  editor.markdownValue = "original\n\nsource";
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
  let sentId = "";
  let sentSelection: any = null;
  const handler = getHandler({
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: true,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor,
    extra: {
      actions: {
        altEnter: (value, id, context) => {
          sent = value;
          sentId = id ?? "";
          sentSelection = context?.selection;
        },
      },
      id: "slate-frame",
      search: EMPTY_SEARCH,
    },
  });

  expect(sent).toBe("original\n\nsource");
  expect(sentId).toBe("slate-frame");
  expect(sentSelection).toEqual(editor.selection);
});
