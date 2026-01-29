/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { withInsertText } from "./insert-text";
import { withDeleteBackward } from "./delete-backward";
import { withDeleteForward } from "./delete-forward";
import type { SlateEditor } from "../editable-markdown";
import {
  Editor,
  Operation,
  Transforms,
  Path,
  Point,
  Text,
  Element,
  Range,
  Node,
} from "slate";
import { len } from "@cocalc/util/misc";
import { markdown_to_slate } from "../markdown-to-slate";
import { applyOperations } from "../operations";
import { slateDiff } from "../slate-diff";
import { getRules } from "../elements";
import { ReactEditor } from "../slate-react";
import { formatHeading, getFocus, setSelectionAndFocus } from "./commands";
import { autoformatBlockquoteAtStart } from "./auto-format-quote";
import { toCodeLines } from "../elements/code-block/utils";
import { ensureRange, getNodeAt, slateDebug } from "../slate-util";

function rememberAutoformatSelection(editor: Editor, selection: Range): void {
  (editor as any).__autoformatSelection = selection;
}

function spacerParagraph(): Element {
  return {
    type: "paragraph",
    spacer: true,
    children: [{ text: "" }],
  } as Element;
}

function autoformatCodeSpanAtCursor(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  let text = node.text;
  let offset = selection.focus.offset;
  if (offset === text.length && text.endsWith(" ")) {
    text = text.slice(0, -1);
    offset -= 1;
  }
  if (offset !== text.length) {
    return false;
  }

  if (!text.endsWith("`")) {
    return false;
  }

  const openIndex = text.lastIndexOf("`", text.length - 2);
  if (openIndex === -1) {
    return false;
  }

  // Don't try to handle escaped backticks or nested backticks.
  if (openIndex > 0 && text[openIndex - 1] === "\\") {
    return false;
  }
  const inner = text.slice(openIndex + 1, text.length - 1);
  if (inner.includes("`")) {
    return false;
  }
  if (inner.length === 0) {
    return false;
  }

  const beforeText = text.slice(0, openIndex);
  const parentPath = Path.parent(path);
  const index = path[path.length - 1];
  const children: any[] = [];

  if (beforeText.length > 0) {
    children.push({ ...node, text: beforeText });
  }
  children.push({ text: inner, code: true });
  children.push({ text: " " });

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: path });
    Transforms.insertNodes(editor, children, { at: parentPath.concat(index) });
  });

  const newPath = parentPath.concat(index + children.length - 1);
  setSelectionAndFocus(
    editor as ReactEditor,
    {
      focus: { path: newPath, offset: 1 },
      anchor: { path: newPath, offset: 1 },
    },
    { force: true },
  );
  rememberAutoformatSelection(editor, {
    focus: { path: newPath, offset: 1 },
    anchor: { path: newPath, offset: 1 },
  });
  return true;
}

function autoformatMarkAtCursor(
  editor: Editor,
  marker: string,
  mark: "bold" | "italic" | "strikethrough",
): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  let text = node.text;
  let offset = selection.focus.offset;
  if (offset === text.length && text.endsWith(" ")) {
    text = text.slice(0, -1);
    offset -= 1;
  }
  if (offset !== text.length) {
    return false;
  }

  if (!text.endsWith(marker)) {
    return false;
  }

  const openIndex = text.lastIndexOf(marker, text.length - marker.length - 1);
  if (openIndex === -1) {
    return false;
  }

  const inner = text.slice(openIndex + marker.length, text.length - marker.length);
  if (inner.length === 0) {
    return false;
  }

  if (inner.includes(marker)) {
    return false;
  }

  const beforeText = text.slice(0, openIndex);
  const parentPath = Path.parent(path);
  const index = path[path.length - 1];
  const children: any[] = [];

  if (beforeText.length > 0) {
    children.push({ ...node, text: beforeText });
  }
  children.push({ text: inner, [mark]: true } as Text);
  children.push({ text: " " });

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: path });
    Transforms.insertNodes(editor, children, { at: parentPath.concat(index) });
  });

  const newPath = parentPath.concat(index + children.length - 1);
  setSelectionAndFocus(
    editor as ReactEditor,
    {
      focus: { path: newPath, offset: 1 },
      anchor: { path: newPath, offset: 1 },
    },
    { force: true },
  );
  rememberAutoformatSelection(editor, {
    focus: { path: newPath, offset: 1 },
    anchor: { path: newPath, offset: 1 },
  });
  return true;
}

function autoformatInlineMathAtCursor(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  let text = node.text;
  let offset = selection.focus.offset;
  if (offset === text.length && text.endsWith(" ")) {
    text = text.slice(0, -1);
    offset -= 1;
  }
  if (offset !== text.length) {
    return false;
  }

  if (!text.endsWith("$")) {
    return false;
  }

  const openIndex = text.lastIndexOf("$", text.length - 2);
  if (openIndex === -1) {
    return false;
  }

  if (openIndex > 0 && text[openIndex - 1] === "\\") {
    return false;
  }

  const inner = text.slice(openIndex + 1, text.length - 1);
  if (inner.length === 0) {
    return false;
  }
  if (inner.includes("$")) {
    return false;
  }

  const beforeText = text.slice(0, openIndex);
  const parentPath = Path.parent(path);
  const index = path[path.length - 1];
  const children: any[] = [];

  if (beforeText.length > 0) {
    children.push({ ...node, text: beforeText });
  }
  children.push({
    type: "math_inline",
    value: inner,
    isInline: true,
    isVoid: true,
    display: false,
    children: [{ text: inner }],
  });
  children.push({ text: " " });

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: path });
    Transforms.insertNodes(editor, children, { at: parentPath.concat(index) });
  });

  const newPath = parentPath.concat(index + children.length - 1);
  setSelectionAndFocus(
    editor as ReactEditor,
    {
      focus: { path: newPath, offset: 1 },
      anchor: { path: newPath, offset: 1 },
    },
    { force: true },
  );
  rememberAutoformatSelection(editor, {
    focus: { path: newPath, offset: 1 },
    anchor: { path: newPath, offset: 1 },
  });
  return true;
}

function autoformatBlockMathAtStart(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  const pos = path[path.length - 1];
  if (path.length !== 2 || pos !== 0) {
    return false;
  }

  const text = node.text;
  const offset = selection.focus.offset;
  if (!text.startsWith("$$")) {
    return false;
  }
  if (offset !== 2) {
    return false;
  }

  const blockPath = path.slice(0, path.length - 1);
  Editor.withoutNormalizing(editor, () => {
    Transforms.delete(editor, {
      at: { path, offset: 0 },
      distance: 2,
    });
    Transforms.setNodes(
      editor,
      {
        type: "math_block",
        display: true,
        value: "",
        isVoid: true,
        children: [{ text: "" }],
      } as any,
      { at: blockPath },
    );
  });

  return true;
}

function autoformatCheckboxAtCursor(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  const paragraphEntry = Editor.above(editor, {
    at: selection.focus,
    match: (node) => Element.isElement(node) && node.type === "paragraph",
  });
  if (!paragraphEntry) {
    return false;
  }
  const [paragraphNode, paragraphPath] = paragraphEntry as [Element, Path];
  const paragraphText = Editor.string(editor, paragraphPath);
  const match = paragraphText.match(/^\[( |x|X)\]\s*/);
  if (!match) {
    return false;
  }

  const markerLength = match[0].length;

  const checked = match[1].toLowerCase() === "x";
  const rest = paragraphText.slice(markerLength).replace(/^\s+/, "");
  const trailingText = rest.length > 0 ? ` ${rest}` : " ";

  const newParagraph: Element = {
    ...(paragraphNode as any),
    type: "paragraph",
    children: [
      { text: "" },
      {
        type: "checkbox",
        isVoid: true,
        isInline: true,
        value: checked,
        children: [{ text: "" }],
      },
      { text: trailingText },
    ],
  };

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: paragraphPath });
    Transforms.insertNodes(editor, newParagraph as any, { at: paragraphPath });
  });

  const textPath = paragraphPath.concat(2);
  setSelectionAndFocus(editor as ReactEditor, {
    focus: { path: textPath, offset: 1 },
    anchor: { path: textPath, offset: 1 },
  });
  rememberAutoformatSelection(editor, {
    focus: { path: textPath, offset: 1 },
    anchor: { path: textPath, offset: 1 },
  });

  return true;
}

function autoformatListAtStart(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  const pos = path[path.length - 1];
  if (path.length !== 2 || pos !== 0) {
    return false;
  }

  const text = node.text;
  const markerMatch = text.match(/^([-*+]|\d+[.)])\s?/);
  if (!markerMatch) {
    return false;
  }

  const marker = markerMatch[1];
  const markerLen = marker.length;
  const offset = selection.focus.offset;
  if (offset !== markerLen && offset !== markerLen + 1) {
    return false;
  }

  const blockPath = path.slice(0, path.length - 1);
  const hasSpace = text.slice(markerLen, markerLen + 1) === " ";
  const deleteCount = hasSpace ? markerLen + 1 : markerLen;

  Editor.withoutNormalizing(editor, () => {
    Transforms.delete(editor, {
      at: { path, offset: 0 },
      distance: deleteCount,
    });
    Transforms.wrapNodes(editor, { type: "list_item" } as Element, {
      at: blockPath,
    });
    const isOrdered = /^\d/.test(marker);
    Transforms.wrapNodes(
      editor,
      {
        type: isOrdered ? "ordered_list" : "bullet_list",
        ...(isOrdered ? { start: parseInt(marker, 10) || 1 } : null),
        tight: true,
      } as Element,
      { at: blockPath },
    );
  });

  const listEntry = Editor.above(editor, {
    at: editor.selection ?? blockPath,
    match: (node) =>
      Element.isElement(node) &&
      (node.type === "bullet_list" || node.type === "ordered_list"),
  }) as [Element, Path] | undefined;
  if ((window as any).__slateDebugLog) {
    try {
      const top = (editor.children || []).map((n: any, idx: number) => ({
        idx,
        type: Element.isElement(n) ? n.type : Text.isText(n) ? "text" : typeof n,
        spacer: n.spacer ?? undefined,
        children: Array.isArray(n.children)
          ? n.children.map((c: any) =>
              Element.isElement(c)
                ? c.type
                : Text.isText(c)
                  ? "text"
                  : typeof c,
            )
          : undefined,
      }));
      slateDebug("autoformat:list:tree", {
        top,
        listEntryPath: listEntry?.[1] ?? null,
        selection: editor.selection ?? null,
      });
    } catch (err) {
      slateDebug("autoformat:list:tree:error", { error: String(err) });
    }
  }
  let listPath: Path | undefined = listEntry?.[1];
  if (!listPath) {
    const isList = (node: unknown) =>
      Element.isElement(node) &&
      (node.type === "bullet_list" || node.type === "ordered_list");
    const tryPath = (path: Path) => {
      if (listPath) return;
      try {
        const node = getNodeAt(editor, path);
        if (isList(node)) listPath = path;
      } catch {
        // ignore invalid path
      }
    };
    tryPath(blockPath);
    tryPath(Path.next(blockPath));
    if (blockPath[blockPath.length - 1] > 0) {
      tryPath(Path.previous(blockPath));
    }
  }
  if (!listPath) {
    listPath = blockPath;
  }
  const listItemEntry = Editor.nodes(editor, {
    at: listPath,
    match: (node) => Element.isElement(node) && node.type === "list_item",
  }).next().value as [Element, Path] | undefined;
  const listItemPath = listItemEntry?.[1] ?? listPath;
  let focus: Point | undefined;
  const textEntry = Editor.nodes(editor, {
    at: listPath,
    match: (node) => Text.isText(node),
  }).next().value as [Text, Path] | undefined;
  if (textEntry) {
    try {
      focus = Editor.start(editor, textEntry[1]);
    } catch {
      // ignore
    }
  }
  if (!focus) {
    try {
      focus = Editor.start(editor, listPath);
    } catch {
      // ignore
    }
  }
  if (focus) {
    (editor as any).__autoformatDidBlock = true;
    (editor as any).__autoformatSelection = { anchor: focus, focus };
    slateDebug("autoformat:list:focus", {
      blockPath,
      listItemPath,
      listPath,
      focus,
      selection: editor.selection ?? null,
      autoformatSelection: (editor as any).__autoformatSelection ?? null,
    });
    setSelectionAndFocus(editor as ReactEditor, { focus, anchor: focus });
  }
  return true;
}

export const withAutoFormat = (editor) => {
  withInsertText(editor);
  withDeleteBackward(editor);
  withDeleteForward(editor);
  const { insertData } = editor;
  if (typeof insertData === "function") {
    editor.insertData = (data) => {
      if (isSelectionInCodeBlock(editor as SlateEditor)) {
        const text = data?.getData?.("text/plain");
        if (text && /[\r\n]/.test(text)) {
          const normalized = text.replace(/\r\n?/g, "\n");
          if (insertMultilineCodeText(editor as SlateEditor, normalized)) {
            return;
          }
        }
        insertData(data);
        return;
      }
      const slateFragment = data?.getData?.("application/x-slate-fragment");
      if (slateFragment) {
        insertData(data);
        return;
      }
      const text = data?.getData?.("text/plain");
      if (!text) {
        insertData(data);
        return;
      }
      const normalized = text.replace(/\r\n?/g, "\n");
      const lineCount = normalized.split("\n").length;
      const MULTILINE_PASTE_THRESHOLD = 2;
      if (lineCount >= MULTILINE_PASTE_THRESHOLD) {
        const pasteId = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        Transforms.insertNodes(
          editor,
          [
            {
              type: "code_block",
              fence: true,
              info: "",
              // Always offer a convert-to-rich-text option for multiline pastes.
              markdownCandidate: true,
              pasteId,
              children: toCodeLines(normalized),
            } as any,
            spacerParagraph(),
          ],
          { at: getFocus(editor) },
        );
        try {
          const entry = Editor.nodes(editor, {
            at: [],
            match: (node) =>
              Element.isElement(node) &&
              node.type === "code_block" &&
              node["pasteId"] === pasteId,
          }).next().value as [Element, Path] | undefined;
          if (entry) {
            const [, codePath] = entry;
            const spacerPath = Path.next(codePath);
            const start = Editor.start(editor, spacerPath);
            setSelectionAndFocus(editor as ReactEditor, {
              anchor: start,
              focus: start,
            });
            Transforms.setNodes(editor, { pasteId: undefined } as any, {
              at: codePath,
            });
          }
        } catch {
          // Ignore selection failures; paste still succeeded.
        }
        return;
      }
      insertData(data);
      markdownAutoformat(editor as SlateEditor);
    };
  }

  return editor;
};

function insertMultilineCodeText(editor: SlateEditor, text: string): boolean {
  if (!editor.selection) return false;
  if (!Range.isCollapsed(editor.selection)) {
    Transforms.delete(editor);
  }
  const focus = editor.selection?.focus;
  if (!focus) return false;
  const lineEntry = Editor.above(editor, {
    at: focus,
    match: (n) => Element.isElement(n) && n.type === "code_line",
  }) as [Element, Path] | undefined;
  if (!lineEntry) return false;
  const [lineNode, linePath] = lineEntry;
  const textEntry = Editor.nodes(editor, {
    at: linePath,
    match: (n) => Text.isText(n),
  }).next().value as [Text, Path] | undefined;
  if (!textEntry) return false;
  const [, textPath] = textEntry;

  const lineText = Node.string(lineNode);
  const offset = Math.max(0, Math.min(focus.offset ?? 0, lineText.length));
  const prefix = lineText.slice(0, offset);
  const suffix = lineText.slice(offset);
  const parts = text.split("\n");
  if (parts.length <= 1) {
    return false;
  }
  const first = prefix + parts[0];
  const tail = parts.slice(1);
  tail[tail.length - 1] = tail[tail.length - 1] + suffix;

  if (lineText.length > 0) {
    Transforms.delete(editor, {
      at: {
        anchor: { path: textPath, offset: 0 },
        focus: { path: textPath, offset: lineText.length },
      },
    });
  }
  if (first.length > 0) {
    Transforms.insertText(editor, first, { at: { path: textPath, offset: 0 } });
  }

  if (tail.length > 0) {
    const nodes = tail.map((line) => ({
      type: "code_line",
      children: [{ text: line }],
    }));
    Transforms.insertNodes(editor, nodes as any, { at: Path.next(linePath) });

    const base = Path.next(linePath);
    const lastPath = [
      ...base.slice(0, -1),
      base[base.length - 1] + (tail.length - 1),
    ];
    const lastLen = tail[tail.length - 1].length;
    const point = { path: lastPath.concat(0), offset: lastLen };
    Transforms.select(editor, point);
  } else {
    const point = { path: textPath, offset: first.length };
    Transforms.select(editor, point);
  }

  return true;
}

// Use conversion back and forth to markdown to autoformat
// what is right before the cursor in the current text node.
// Returns true if autoformat actually happens.
export function markdownAutoformat(editor: SlateEditor): boolean {
  if (isSelectionInCodeBlock(editor)) return false;
  const { selection } = editor;
  if (!selection) return false;
  const markAutoformat = (applied: boolean): boolean => {
    if (applied) {
      const pendingSelection =
        (editor as any).__autoformatSelection ?? ensureRange(editor, editor.selection);
      (editor as any).__autoformatSelection = pendingSelection;
    }
    return applied;
  };
  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch (_) {
    // this can happen in case selection is messed up, which could happen
    // in rare cases still.  I saw it in production once.
    return false;
  }

  // Must be a text node
  if (!Text.isText(node)) return false;

  if (markAutoformat(autoformatBlockquoteAtStart(editor))) return true;
  if (markAutoformat(autoformatListAtStart(editor))) return true;
  if (markAutoformat(autoformatCheckboxAtCursor(editor))) return true;
  if (markAutoformat(autoformatCodeSpanAtCursor(editor))) return true;
  if (markAutoformat(autoformatBlockMathAtStart(editor))) return true;
  if (markAutoformat(autoformatInlineMathAtCursor(editor))) return true;
  if (markAutoformat(autoformatMarkAtCursor(editor, "**", "bold"))) return true;
  if (markAutoformat(autoformatMarkAtCursor(editor, "__", "bold"))) return true;
  if (markAutoformat(autoformatMarkAtCursor(editor, "~~", "strikethrough")))
    return true;
  if (markAutoformat(autoformatMarkAtCursor(editor, "*", "italic"))) return true;
  if (markAutoformat(autoformatMarkAtCursor(editor, "_", "italic"))) return true;

  // If we wanted the format to always be undo-able.
  // editor.saveValue(true);

  let r: boolean | Function = false;
  try {
    let paragraphTextOverride: string | undefined;
    if (selection.focus.path.length >= 2 && selection.focus.path[selection.focus.path.length - 1] === 0) {
      const paragraphEntry = Editor.above(editor, {
        at: selection.focus.path,
        match: (node) => Element.isElement(node) && node.type === "paragraph",
      });
      if (paragraphEntry) {
        const [, paragraphPath] = paragraphEntry;
        paragraphTextOverride = Editor.string(editor, paragraphPath).trimRight();
      }
    }
    Editor.withoutNormalizing(editor, () => {
      editor.apply({
        type: "split_node",
        path: selection.focus.path,
        position: selection.focus.offset,
        properties: node, // important to preserve text properties on split (seems fine to leave text field)
      });
      r = markdownAutoformatAt(editor, selection.focus.path, paragraphTextOverride);
    });
  } catch (err) {
    console.warn(`SLATE -- issue in markdownAutoformat ${err}`);
  }

  if (typeof r == "function") {
    // code to run after normalizing.
    // @ts-ignore
    r();
    r = true;
  }
  if (r) {
    const pendingSelection =
      (editor as any).__autoformatSelection ?? ensureRange(editor, editor.selection);
    (editor as any).__autoformatSelection = pendingSelection;
  }
  return r;
}

function isSelectionInCodeBlock(editor: SlateEditor): boolean {
  const selection = editor.selection ?? editor.lastSelection;
  if (!selection) return false;
  const entry = Editor.above(editor, {
    at: selection.focus,
    match: (node) => Element.isElement(node) && node.type === "code_block",
  });
  return !!entry;
}

// Use conversion back and forth to markdown to autoformat
// what is in the current text node.
function markdownAutoformatAt(
  editor: SlateEditor,
  path: Path,
  paragraphTextOverride?: string,
): boolean | Function {
  const [node] = Editor.node(editor, path);
  // Must be a text node
  if (!Text.isText(node)) return false;
  const pos = path[path.length - 1]; // position among siblings.

  // Find the first whitespace from the end after triming whitespace.
  // This is what we autoformat on by default, since it is the most predictable,
  // and doesn't suddenly do something with text earlier in the node
  // that the user already explicitly decided not to autoformat.
  // NOTE that there are several cases below where we move start back though,
  // e.g., checkboxes that are written using "[ ]".
  let text = node.text;
  if (text.endsWith(" ")) {
    // do not autoformat if there is already whitespace at the end, e.g., maybe
    // user chose not to autoformat this earlier.
    return false;
  }
  let start = text.lastIndexOf(" ", text.trimRight().length - 1);

  // Special case some block level formatting (for better handling and speed).
  if (path.length == 2 && pos == 0 && start <= 0) {
    switch (text) {
      case "#":
      case "##":
      case "###":
      case "####":
      case "#####":
      case "######":
        // This could sets the block containing the selection
        // to be formatted with exactly the right heading.
        formatHeading(editor, text.length);
        // However, because we just typed some hashes to get this
        // to happen, we need to delete them.  But this has to wait
        // until after normalize, and this whole function is run
        // in a withoutNormalizing block, so we return some code to
        // run afterwards.
        return () => editor.deleteBackward("word");
    }
  }

  // However, there are some cases where we extend the range of
  // the autofocus further to the left from start:
  //    - "[ ]" for checkboxes.
  //    - "[link text](url)", since link text may have spaces in it.
  //    - formatting, e.g., "consider `foo bar`".
  //    - NOTE: I'm not allowing for space in  math formulas ($ or $$) here,
  //      since it is very annoying if you trying to type USD amounts. A
  //      workaround is create the inline formula with no spaces, then edit it.
  const text0 = text.trimRight();
  if (text0.endsWith(")") && text0.includes("[") && text0.includes("](")) {
    // may be a link such as [link text](url):
    const i = text.lastIndexOf("[");
    if (i != -1) {
      start = Math.min(i - 1, start);
    }
  } else if (text0.endsWith("]") && text0.includes("[")) {
    const i = text.lastIndexOf("[");
    if (i != -1) {
      start = Math.min(i - 1, start);
    }
  } else {
    // The text formatting markers and *also* math formatting.
    // Note that $$ is first since $ would match it.
    for (const delim of ["`", "**", "*", "_", "~~", "$$", "$"]) {
      if (text0.endsWith(delim)) {
        const i = text.lastIndexOf(delim, text0.length - delim.length - 1);
        if (i != -1) {
          start = Math.min(i - 1, start);
          break;
        }
      }
    }
  }

  text = text.slice(start + 1).trim();
  if (text.length == 0) return false;

  // If we're at the start of a paragraph and doing a block-level autoformat
  // (e.g., list), include the rest of the paragraph text so it doesn't get
  // dropped when we replace the paragraph with a block element.
  if (path.length >= 2 && pos === 0 && start <= 0) {
    const paragraphText =
      paragraphTextOverride ??
      (() => {
        const paragraphEntry = Editor.above(editor, {
          at: path,
          match: (node) => Element.isElement(node) && node.type === "paragraph",
        });
        if (!paragraphEntry) return "";
        const [, paragraphPath] = paragraphEntry;
        return Editor.string(editor, paragraphPath).trimRight();
      })();
    if (paragraphText.length > 0) {
      text = paragraphText;
      // If a list marker was typed without a space (e.g., "-foo") and
      // the autoformat is triggered by the space key, insert the missing
      // space so markdown parsing recognizes the list.
      const markerMatch = text.match(/^([-*+]|\d+[.)])(?=\S)/);
      if (markerMatch) {
        const marker = markerMatch[1];
        text = marker + " " + text.slice(marker.length);
      }
    }
  }


  // make a copy to avoid any caching issues (??).
  let doc = [...(markdown_to_slate(text, true) as any)];

  const listMatch = text.match(/^([-*+]|\d+[.)])\s+(.*)$/);
  if (
    listMatch &&
    doc.length === 1 &&
    doc[0].type === "paragraph" &&
    Text.isText(doc[0].children?.[0])
  ) {
    const marker = listMatch[1];
    const remainder = listMatch[2] ?? "";
    const remainderDoc = markdown_to_slate(remainder, true) as any;
    const remainderChildren =
      remainderDoc.length === 1 && remainderDoc[0].type === "paragraph"
        ? remainderDoc[0].children
        : [{ text: remainder }];
    const listItem = {
      type: "list_item",
      children: [
        {
          type: "paragraph",
          blank: remainder.trim().length === 0,
          children: remainderChildren,
        },
      ],
    };
    const isOrdered = /^\d/.test(marker);
    doc = [
      {
        type: isOrdered ? "ordered_list" : "bullet_list",
        ...(isOrdered ? { start: parseInt(marker, 10) || 1 } : null),
        tight: true,
        children: [listItem],
      },
    ];
  }
  // console.log(`autoformat '${text}' = \n`, JSON.stringify(doc, undefined, 2));

  if (
    doc.length == 1 &&
    doc[0].type == "paragraph" &&
    doc[0].children.length == 1 &&
    Text.isText(doc[0].children[0]) &&
    doc[0].children[0].text.trim() == text.trim()
  ) {
    // No "auto format" action since no real change.
    return false;
  }

  const isInline =
    doc.length == 1 &&
    doc[0].type == "paragraph" &&
    Text.isText(doc[0].children[0]);

  if (!isInline) {
    if (start > 0 || pos > 0) {
      return false;
    }
  }

  // **INLINE CASE**
  if (isInline) {
    const children = doc[0].children;
    if (start != -1) {
      if (children[0]["text"] === "") {
        // In case the first node in children is empty text, remove that,
        // since otherwise it will get normalized away after doing this,
        // and that throws the cursor computation off below, causing a crash.
        children.shift();
      }
      // Add text from before starting point back, since we excluded it above.
      const first = { ...node };
      first.text = node.text.slice(0, start + 1);
      children.unshift(first);
    }
    // Add a space at the end.
    if (
      len(children[children.length - 1]) == 1 &&
      children[children.length - 1]["text"] != null
    ) {
      // text node with NO marks, i.e., it is plain text.
      children[children.length - 1]["text"] += " ";
    } else {
      // last node has marks so we append another node.
      children.push({ text: " " });
    }

    // Find a sequence of operations that converts our input
    // text node into the new list of inline nodes.
    const operations = slateDiff(
      [node],
      children,
      path.slice(0, path.length - 1)
    );

    // Adjust the last entry in path for each operation computed
    // above to account for fact that node might not be first sibling.
    for (const op of operations) {
      shift_path(op, pos);
    }

    applyOperations(editor, operations);
    // Move the cursor to the right position.
    const new_path = [...path];
    new_path[new_path.length - 1] += children.length - 1;
    const new_cursor = {
      offset: children[children.length - 1]["text"].length,
      path: new_path,
    };
    focusEditorAt(editor, new_cursor);
  } else {
    // **NON-INLINE CASE**
    (editor as any).__autoformatDidBlock = true;
    // Remove the containing paragraph (not just the text node) so the new
    // block-level doc replaces it without leaving an empty paragraph.
    const paragraphEntry = Editor.above(editor, {
      at: path,
      match: (node) => Element.isElement(node) && node.type === "paragraph",
    });
    const blockPath = paragraphEntry?.[1] ?? Path.parent(path);
    Transforms.removeNodes(editor, { at: blockPath });
    Transforms.insertNodes(editor, doc, { at: blockPath });

    // Normally just move the cursor beyond what was just
    // inserted, though sometimes it makes more sense to
    // focus it.
    const type = doc[0].type;
    const rules = getRules(type);
    if (type === "code_block") {
      slateDebug("autoformat:code_block", {
        blockPath,
        selection: editor.selection ?? null,
        childrenLen: editor.children?.length ?? null,
      });
      // Due to spacer insertion, the code_block may have shifted forward.
      let codePath = blockPath;
      let node: Node | null = null;
      try {
        node = Editor.node(editor, codePath)[0] as Node;
      } catch {
        node = null;
      }
      if (!(Element.isElement(node) && node.type === "code_block")) {
        const nextPath = Path.next(blockPath);
        try {
          const nextNode = Editor.node(editor, nextPath)[0] as Node;
          if (Element.isElement(nextNode) && nextNode.type === "code_block") {
            codePath = nextPath;
          }
        } catch {
          // fall through to original path
        }
      }
      const focus = Editor.start(editor, codePath);
      (editor as any).__autoformatSelection = { anchor: focus, focus };
      slateDebug("autoformat:code_block:focus", {
        blockPath,
        codePath,
        focus,
        selection: editor.selection ?? null,
        autoformatSelection: (editor as any).__autoformatSelection ?? null,
      });
      setSelectionAndFocus(editor, { focus, anchor: focus });
      return true;
    }
    if (type === "html_block" || type === "meta") {
      // Move cursor after the block so typing continues in a paragraph.
      const afterPath = Path.next(blockPath);
      let nextNode: Node | null = null;
      if (Node.has(editor, afterPath)) {
        nextNode = Editor.node(editor, afterPath)[0] as Node;
      }
      if (!Element.isElement(nextNode) || nextNode.type !== "paragraph") {
        Transforms.insertNodes(editor, { type: "paragraph", children: [{ text: "" }] }, { at: afterPath });
      }
      const focus = Editor.start(editor, afterPath);
      setSelectionAndFocus(editor, { focus, anchor: focus });
      return true;
    }
    if (type === "bullet_list" || type === "ordered_list") {
      const listItemPath = blockPath.concat(0);
      const paragraphPathInList = listItemPath.concat(0);
      const focus = Editor.start(editor, paragraphPathInList);
      (editor as any).__autoformatSelection = { anchor: focus, focus };
      slateDebug("autoformat:list:focus", {
        blockPath,
        listItemPath,
        focus,
        selection: editor.selection ?? null,
        autoformatSelection: (editor as any).__autoformatSelection ?? null,
      });
      setSelectionAndFocus(editor, { focus, anchor: focus });
      return true;
    }
    if (!rules?.autoFocus) {
      // move cursor out of the newly created block element.
      Transforms.move(editor, { distance: 1 });
    }
    if (rules?.autoAdvance) {
      setSelectionAndFocus(editor, {
        focus: { path, offset: 0 },
        anchor: { path, offset: 0 },
      });
      Transforms.move(editor, { distance: 1, unit: "line" });
    }
  }
  return true;
}

function shift_path(op: Operation, shift: number): void {
  const path = [...op["path"]];
  path[path.length - 1] += shift;
  op["path"] = path;
}

// This is pretty scary, but I need it especially in the weird case
// where you insert a checkbox in an empty document and everything
// loses focus.
// This is a SCARY function..
export function focusEditorAt(editor: ReactEditor, point: Point): void {
  setSelectionAndFocus(editor, { focus: point, anchor: point }, { force: true });
}
