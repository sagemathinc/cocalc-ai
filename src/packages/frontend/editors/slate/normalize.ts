/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* Ideas for things to put here that aren't here now:

- merging adjacent lists, since the roundtrip to markdown does that.

WARNING: The following warning used to apply.  However, we now normalize
markdown_to_slate always, so it does not apply: "Before very very very
careful before changing anything here!!!
It is absolutely critical that the output of markdown_to_slate be normalized
according to all the rules here.  If you change a rule here, that will
likely break this assumption and things will go to hell.  Be careful.""

*/

import { Editor, Element, Node, Path, Range, Text, Transforms } from "slate";
import { isEqual } from "lodash";

import { getNodeAt } from "./slate-util";
import { emptyParagraph, isWhitespaceParagraph } from "./padding";
import { isListElement } from "./elements/list";
import { getCodeBlockText, toCodeLines } from "./elements/code-block/utils";

interface NormalizeInputs {
  editor?: Editor;
  node?: Node;
  path?: Path;
}

type NormalizeFunction = (NormalizeInputs) => void;

const NORMALIZERS: NormalizeFunction[] = [];

function spacerParagraph(): Element {
  return {
    type: "paragraph",
    spacer: true,
    children: [{ text: "" }],
  } as Element;
}

export const withNormalize = (editor) => {
  const { normalizeNode } = editor;

  editor.normalizeNode = (entry) => {
    const [node, path] = entry;

    for (const f of NORMALIZERS) {
      //const before = JSON.stringify(editor.children);
      const before = editor.children;
      f({ editor, node, path });
      if (before !== editor.children) {
        // changed so return; normalize will get called again by
        // slate until no changes.
        return;
      }
    }

    // No changes above, so fall back to the original `normalizeNode`
    // to enforce other constraints.  Important to not call any normalize
    // if there were any changes, since they can make the entry invalid!
    normalizeNode(entry);
  };

  return editor;
};

// This does get called if you somehow blank the document. It
// gets called with path=[], which makes perfect sense.  If we
// don't put something in, then things immediately break due to
// selection assumptions.  Slate doesn't do this automatically,
// since it doesn't nail down the internal format of a blank document.
NORMALIZERS.push(function ensureDocumentNonempty({ editor }) {
  if (editor.children.length == 0) {
    Editor.insertNode(editor, emptyParagraph());
  }
});

// Ensure every list_item is contained in a list.
NORMALIZERS.push(function ensureListItemInAList({ editor, node, path }) {
  if (Element.isElement(node) && node.type === "list_item") {
    const [parent] = Editor.parent(editor, path);
    if (!isListElement(parent)) {
      // invalid document: every list_item should be in a list.
      Transforms.wrapNodes(editor, { type: "bullet_list" } as Element, {
        at: path,
      });
    }
  }
});

// Ensure every immediate child of a list is a list_item. Also, ensure
// that the children of each list_item are block level elements, since this
// makes list manipulation much easier and more consistent.
NORMALIZERS.push(function ensureListContainsListItems({ editor, node, path }) {
  if (
    Element.isElement(node) &&
    (node.type === "bullet_list" || node.type == "ordered_list")
  ) {
    let i = 0;
    for (const child of node.children) {
      if (!Element.isElement(child) || child.type != "list_item") {
        // invalid document: every child of a list should be a list_item
        Transforms.wrapNodes(editor, { type: "list_item" } as Element, {
          at: path.concat([i]),
          mode: "lowest",
        });
        return;
      }
      if (!Element.isElement(child.children[0])) {
        // if the the children of the list item are leaves, wrap
        // them all in a paragraph (for consistency with what our
        // convertor from markdown does, and also our doc manipulation,
        // e.g., backspace, assumes this).
        Transforms.wrapNodes(editor, { type: "paragraph" } as Element, {
          mode: "lowest",
          match: (node) => !Element.isElement(node),
          at: path.concat([i]),
        });
      }
      i += 1;
    }
  }
});

// Ensure block elements always have at least one text child.
NORMALIZERS.push(function ensureBlockHasChild({ editor, node, path }) {
  if (!Element.isElement(node)) return;
  if (!Editor.isBlock(editor, node)) return;
  if (node.children.length > 0) return;
  Transforms.insertNodes(editor, { text: "" }, { at: path.concat(0) });
});

// Normalize code blocks to use code_line children instead of legacy value.
NORMALIZERS.push(function normalizeCodeBlockChildren({ editor, node, path }) {
  if (!(Element.isElement(node) && node.type === "code_block")) return;
  const children = node.children ?? [];
  const hasOnlyCodeLines = children.every(
    (child) => Element.isElement(child) && child.type === "code_line"
  );
  if (hasOnlyCodeLines && node.value == null) return;

  const code = getCodeBlockText(node as any);
  const nextLines = toCodeLines(code);
  Transforms.removeNodes(editor, {
    at: path,
    match: (_n, p) => p.length === path.length + 1,
  });
  Transforms.insertNodes(editor, nextLines, { at: path.concat(0) });
  Transforms.setNodes(editor, { value: undefined, isVoid: false }, { at: path });
});

// Ensure each code_line is a single plain text node so Prism decorations
// align with offsets (and don't get split across multiple leaves).
NORMALIZERS.push(function normalizeCodeLineChildren({ editor, node, path }) {
  if (!(Element.isElement(node) && node.type === "code_line")) return;
  const text = Node.string(node);
  const children = node.children ?? [];
  const onlyText =
    children.length === 1 &&
    Text.isText(children[0]) &&
    children[0].text === text &&
    Object.keys(children[0]).length === 1;
  if (onlyText) return;
  Transforms.removeNodes(editor, {
    at: path,
    match: (_n, p) => p.length === path.length + 1,
  });
  Transforms.insertNodes(editor, { text }, { at: path.concat(0) });
});

const SPACER_BLOCK_TYPES = new Set<string>([
  "code_block",
  "blockquote",
  "html_block",
  "meta",
  "math_block",
]);

function needsSpacerParagraph(editor: Editor, node: Element, _path?: Path): boolean {
  if (SPACER_BLOCK_TYPES.has(node.type)) return true;
  if (!Editor.isBlock(editor, node)) return false;
  return Editor.isVoid(editor, node);
}

function shiftSelectionForInsert(
  selection: Range | null | undefined,
  atPath: Path,
  shift: number
): Range | null {
  if (!selection) return null;
  const shiftPoint = (point: Range["anchor"]): Range["anchor"] => {
    const { path, offset } = point;
    if (path.length < atPath.length) return point;
    for (let i = 0; i < atPath.length - 1; i += 1) {
      if (path[i] !== atPath[i]) return point;
    }
    const idx = atPath.length - 1;
    if (path[idx] < atPath[idx]) return point;
    const nextPath = [...path];
    nextPath[idx] += shift;
    return { path: nextPath, offset };
  };
  return {
    anchor: shiftPoint(selection.anchor),
    focus: shiftPoint(selection.focus),
  };
}

// Ensure block void elements (and code blocks) are surrounded by spacer
// paragraphs so navigation works like normal text paragraphs (no gap cursors).
NORMALIZERS.push(function ensureBlockVoidSpacers({ editor, node, path }) {
  if (!Element.isElement(node)) return;
  if (!needsSpacerParagraph(editor, node, path)) return;
  if (path.length === 0) return;
  const index = path[path.length - 1];
  let codePath = path;
  if (index > 0) {
    const prevPath = Path.previous(path);
    const prevNode = getNodeAt(editor, prevPath);
    if (!(Element.isElement(prevNode) && prevNode.type === "paragraph")) {
      const shifted = shiftSelectionForInsert(editor.selection, path, 1);
      Transforms.insertNodes(editor, spacerParagraph(), { at: path });
      codePath = Path.next(path);
      if ((editor as any).__autoformatDidBlock) {
        const nextNode = getNodeAt(editor, codePath);
        if (Element.isElement(nextNode) && nextNode.type === "code_block") {
          const focus = Editor.start(editor, codePath);
          Transforms.setSelection(editor, { anchor: focus, focus });
        } else if (shifted) {
          Transforms.setSelection(editor, shifted);
        }
      } else if (shifted) {
        Transforms.setSelection(editor, shifted);
      }
    }
  } else {
    const shifted = shiftSelectionForInsert(editor.selection, path, 1);
    Transforms.insertNodes(editor, spacerParagraph(), { at: path });
    codePath = Path.next(path);
    if ((editor as any).__autoformatDidBlock) {
      const nextNode = getNodeAt(editor, codePath);
      if (Element.isElement(nextNode) && nextNode.type === "code_block") {
        const focus = Editor.start(editor, codePath);
        Transforms.setSelection(editor, { anchor: focus, focus });
      } else if (shifted) {
        Transforms.setSelection(editor, shifted);
      }
    } else if (shifted) {
      Transforms.setSelection(editor, shifted);
    }
  }
  const nextPath = Path.next(codePath);
  const nextNode = getNodeAt(editor, nextPath);
  if (!(Element.isElement(nextNode) && nextNode.type === "paragraph")) {
    Transforms.insertNodes(editor, spacerParagraph(), { at: nextPath });
  }
  if ((editor as any).__autoformatDidBlock && node.type === "code_block") {
    (editor as any).__autoformatDidBlock = false;
  }
});

// Remove spacer flag once user types, and drop stray spacer paragraphs
// that no longer neighbor a code block.
NORMALIZERS.push(function normalizeSpacerParagraph({ editor, node, path }) {
  if (!(Element.isElement(node) && node.type === "paragraph")) return;
  if (node["spacer"] !== true) return;
  if (!isWhitespaceParagraph(node)) {
    Transforms.setNodes(editor, { spacer: false } as any, { at: path });
    return;
  }
  if (path.length === 0) return;
  const prevNode = path[path.length - 1] > 0 ? getNodeAt(editor, Path.previous(path)) : null;
  const nextNode = getNodeAt(editor, Path.next(path));
  const hasSpacerNeighbor =
    (Element.isElement(prevNode) &&
      needsSpacerParagraph(editor, prevNode, path && Path.previous(path))) ||
    (Element.isElement(nextNode) &&
      needsSpacerParagraph(editor, nextNode, path && Path.next(path)));
  if (!hasSpacerNeighbor) {
    Transforms.removeNodes(editor, { at: path });
  }
});

// Keep math node value in sync with its editable text and ensure math nodes
// are not treated as void.
NORMALIZERS.push(function normalizeMathValue({ editor, node, path }) {
  if (!Element.isElement(node)) return;
  if (node.type !== "math_inline" && node.type !== "math_block") return;
  const text = Node.string(node);
  const stripped = stripMathDelimiters(text);
  if (stripped !== text) {
    Editor.withoutNormalizing(editor, () => {
      // Replace children with the stripped text so math renders once.
      while (node.children.length > 0) {
        Transforms.removeNodes(editor, { at: path.concat(0) });
      }
      Transforms.insertNodes(editor, { text: stripped }, { at: path.concat(0) });
      Transforms.setNodes(editor, { value: stripped } as any, { at: path });
    });
    return;
  }
  if (node.value !== stripped) {
    Transforms.setNodes(editor, { value: stripped } as any, { at: path });
    return;
  }
});

// Keep html/meta node values in sync with their editable text.
NORMALIZERS.push(function normalizeHtmlMetaValue({ editor, node, path }) {
  if (!Element.isElement(node)) return;
  if (
    node.type !== "html_inline" &&
    node.type !== "html_block" &&
    node.type !== "meta"
  ) {
    return;
  }
  if ((node as any).isVoid) {
    Transforms.setNodes(editor, { isVoid: false } as any, { at: path });
  }
  if ((node as any).isVoid !== false) return;
  const text =
    node.type === "meta"
      ? ((node as any).value ?? "")
      : ((node as any).html ?? "");
  const hasOnlyCodeLines =
    node.type !== "html_inline" &&
    (node.children ?? []).every(
      (child) => Element.isElement(child) && child.type === "code_line",
    );
  if (node.type !== "html_inline") {
    if (!hasOnlyCodeLines) {
      const desiredLines = toCodeLines(text);
      Editor.withoutNormalizing(editor, () => {
        Transforms.removeNodes(editor, {
          at: path,
          match: (_n, p) => p.length === path.length + 1,
        });
        Transforms.insertNodes(editor, desiredLines, { at: path.concat(0) });
      });
      return;
    }
  }
  const current =
    node.type === "html_inline"
      ? Node.string(node)
      : getCodeBlockText(node as any);
  if (node.type === "meta") {
    const value = (node as any).value ?? "";
    if (current !== value) {
      Transforms.setNodes(editor, { value: current } as any, { at: path });
    }
    return;
  }
  const html = (node as any).html ?? "";
  if (current !== html) {
    Transforms.setNodes(editor, { html: current } as any, { at: path });
  }
});

function stripMathDelimiters(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
    return trimmed.slice(2, -2).trim();
  }
  return s;
}

/*
Trim *all* whitespace from the beginning of blocks whose first child is Text,
since markdown doesn't allow for it. (You can use &nbsp; of course.)
*/
NORMALIZERS.push(function trimLeadingWhitespace({ editor, node, path }) {
  if (
    Element.isElement(node) &&
    node.type !== "code_line" &&
    node.type !== "code_block" &&
    Text.isText(node.children[0])
  ) {
    const firstText = node.children[0].text;
    if (firstText != null) {
      // We actually get rid of spaces and tabs, but not ALL whitespace.  For example,
      // if you type "&nbsp; bar", then autoformat turns that into *two* whitespace
      // characters, with the &nbsp; being ascii 160, which counts if we just searched
      // via .search(/\S|$/), but not if we explicitly only look for space or tab as below.
      const i = firstText.search(/[^ \t]|$/);
      if (i > 0) {
        const p = path.concat([0]);
        const { selection } = editor;
        const text = firstText.slice(0, i);
        editor.apply({ type: "remove_text", offset: 0, path: p, text });
        if (
          selection != null &&
          Range.isCollapsed(selection) &&
          isEqual(selection.focus.path, p)
        ) {
          const offset = Math.max(0, selection.focus.offset - i);
          const focus = { path: p, offset };
          Transforms.setSelection(editor, { focus, anchor: focus });
        }
      }
    }
  }
});

/*
If there are two adjacent lists of the same type, merge the second one into
the first.
*/
NORMALIZERS.push(function mergeAdjacentLists({ editor, node, path }) {
  if (
    Element.isElement(node) &&
    (node.type === "bullet_list" || node.type === "ordered_list")
  ) {
    try {
      const nextPath = Path.next(path);
      const nextNode = getNodeAt(editor, nextPath);
      if (Element.isElement(nextNode) && nextNode.type == node.type) {
        // We have two adjacent lists of the same type: combine them.
        // Note that we do NOT take into account tightness when deciding
        // whether to merge, since in markdown you can't have a non-tight
        // and tight list of the same type adjacent to each other anyways.
        Transforms.mergeNodes(editor, { at: nextPath });
        return;
      }
    } catch (_) {} // because prev or next might not be defined

    try {
      const previousPath = Path.previous(path);
      const previousNode = getNodeAt(editor, previousPath);
      if (Element.isElement(previousNode) && previousNode.type == node.type) {
        Transforms.mergeNodes(editor, { at: path });
      }
    } catch (_) {}
  }
});

// Delete any empty links (with no text content), since you can't see them.
// This is a questionable design choice, e.g,. maybe people want to use empty
// links as a comment hack, as explained here:
//  https://stackoverflow.com/questions/4823468/comments-in-markdown
// However, those are the footnote style links.  The inline ones don't work
// anyways as soon as there is a space.
NORMALIZERS.push(function removeEmptyLinks({ editor, node, path }) {
  if (
    Element.isElement(node) &&
    node.type === "link" &&
    node.children.length == 1 &&
    node.children[0]?.["text"] === ""
  ) {
    Transforms.removeNodes(editor, { at: path });
  }
});
