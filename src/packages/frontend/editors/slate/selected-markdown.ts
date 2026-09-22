import type { Descendant } from "slate";
import { Text } from "slate";
import { slate_to_markdown } from "./slate-to-markdown";
import { getCodeBlockText, toCodeLines } from "./elements/code-block/utils";
import type { CodeBlock } from "./elements/code-block/types";

function selectedText(element: HTMLElement, range: Range): string {
  const clipped = element.ownerDocument.createRange();
  clipped.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
    clipped.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
    clipped.setEnd(range.endContainer, range.endOffset);
  return clipped.toString();
}

// Trim text leaves using DOM boundaries, but retain the actual Slate ancestors
// and marks. HTML-to-text conversion would lose list structure, links and math.
export function staticSelectedMarkdown(
  root: HTMLElement,
  nodes: Descendant[],
  range: Range,
): string {
  const trim = (node: Descendant, path: number[]): Descendant | undefined => {
    const element = root.querySelector<HTMLElement>(
      `[data-static-slate-path="${path.join(".")}"]`,
    );
    if (element && !range.intersectsNode(element)) return;
    if (Text.isText(node)) {
      if (!element) return;
      const text = selectedText(element, range);
      return text ? { ...node, text } : undefined;
    }
    if (node.type === "code_block") {
      // Code renders highlighted HTML rather than mapped Slate leaves. Only
      // clip it when the visible payload matches the source, never quote hidden
      // lines from a collapsed preview or controls/output beside the code.
      const code = element?.querySelector<HTMLElement>(
        "pre.cocalc-slate-code-block",
      );
      if (!code) {
        throw Error(
          "This code rendering cannot be quoted as formatted Markdown.",
        );
      }
      if (code.textContent !== getCodeBlockText(node as CodeBlock)) {
        throw Error(
          "Expand the code block and finish editing it before quoting.",
        );
      }
      if (!range.intersectsNode(code)) return;
      const text = selectedText(code, range);
      return text
        ? ({ ...node, value: text, children: toCodeLines(text) } as Descendant)
        : undefined;
    }
    const children = node.children.flatMap((child, index) => {
      const selected = trim(child, [...path, index]);
      return selected ? [selected] : [];
    });
    // Filtering preserves each element's existing child types.
    if (children.length) return { ...node, children } as Descendant;
    // Rendered void nodes (e.g. math) have no rendered Slate text children.
    if (element && !element.querySelector("[data-static-slate-path]"))
      return node;
  };
  const fragment = nodes.flatMap((node, index) => {
    const selected = trim(node, [index]);
    return selected ? [selected] : [];
  });
  return slate_to_markdown(fragment);
}
