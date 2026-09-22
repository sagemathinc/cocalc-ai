import type { Descendant } from "slate";
import { Text } from "slate";
import { slate_to_markdown } from "./slate-to-markdown";

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
      const clipped = element.ownerDocument.createRange();
      clipped.selectNodeContents(element);
      if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
        clipped.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
        clipped.setEnd(range.endContainer, range.endOffset);
      const text = clipped.toString();
      return text ? { ...node, text } : undefined;
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
