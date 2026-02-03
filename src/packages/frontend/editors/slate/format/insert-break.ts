/*
 * This helper overrides Slate's insertBreak to preserve code-block structure
 * and add simple autoindent. It only changes behavior inside code blocks,
 * delegating to the default insertBreak everywhere else.
 */

import { Editor, Element, Range, Transforms } from "slate";
import type { SlateEditor } from "../types";
import { getCodeBlockText } from "../elements/code-block/utils";
import type { CodeBlock } from "../elements/code-block/types";

const PYTHON_INFOS = new Set([
  "py",
  "python",
  "python3",
  "python2",
  "py3",
  "py2",
]);
const YAML_INFOS = new Set(["yaml", "yml"]);

function isColonIndentLanguage(info: string): boolean {
  const key = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return PYTHON_INFOS.has(key) || YAML_INFOS.has(key);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function guessIndentUnit(codeBlock: CodeBlock, baseIndent: string): string {
  if (baseIndent.includes("\t")) {
    return "\t";
  }
  const codeText = getCodeBlockText(codeBlock);
  const indentLengths = codeText
    .split("\n")
    .map((line) => line.match(/^[ ]+/)?.[0].length ?? 0)
    .filter((len) => len > 0);
  if (indentLengths.length > 0) {
    const unit = indentLengths.reduce((acc, len) => gcd(acc, len));
    if (unit > 0) {
      return " ".repeat(unit);
    }
  }
  const infoKey = codeBlock.info?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (PYTHON_INFOS.has(infoKey)) {
    return "    ";
  }
  if (YAML_INFOS.has(infoKey)) {
    return "  ";
  }
  return "  ";
}

export const withInsertBreak = (editor: SlateEditor) => {
  const { insertBreak } = editor;

  editor.insertBreak = () => {
    const selection = editor.selection;
    if (selection) {
      const lineEntry = Editor.above(editor, {
        at: selection,
        match: (n) => Element.isElement(n) && n.type === "code_line",
      });
      if (lineEntry) {
        const codeBlockEntry = Editor.above(editor, {
          at: selection,
          match: (n) => Element.isElement(n) && n.type === "code_block",
        });
        if (!codeBlockEntry) {
          insertBreak();
          return;
        }
        if (Range.isExpanded(selection)) {
          Transforms.delete(editor);
        }
        const [, linePath] = lineEntry;
        const lineStart = Editor.start(editor, linePath);
        const beforeText = Editor.string(editor, {
          anchor: lineStart,
          focus: selection.anchor,
        });
        const indentMatch = beforeText.match(/^[\t ]*/);
        const baseIndent = indentMatch?.[0] ?? "";
        let indent = baseIndent;
        const trimmedBefore = beforeText.replace(/\s+$/, "");
        const codeBlock = codeBlockEntry[0] as CodeBlock;
        if (
          trimmedBefore.endsWith(":") &&
          isColonIndentLanguage(codeBlock.info ?? "")
        ) {
          indent += guessIndentUnit(codeBlock, baseIndent);
        }
        insertBreak();
        if (indent) {
          Transforms.insertText(editor, indent);
        }
        return;
      }
    }
    insertBreak();
  };

  return editor;
};
