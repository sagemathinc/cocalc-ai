import type { Node } from "slate";
import { Node as SlateNode } from "slate";

export function slate_to_markdown(
  slate: Node[],
  _options?: {
    no_escape?: boolean;
    hook?: (node: Node) => undefined | ((text: string) => string);
    cache?;
    noCache?: Set<number>;
    preserveBlankLines?: boolean;
  },
): string {
  if (!slate || slate.length === 0) return "";
  return slate
    .map((node) => {
      const anyNode = node as any;
      if (anyNode.type === "blockquote") {
        const lines = Array.isArray(anyNode.children)
          ? anyNode.children.map((child: Node) => {
              const text = SlateNode.string(child);
              return text.length === 0 ? ">" : `> ${text}`;
            })
          : [];
        return lines.join("\n");
      }
      if (anyNode.type === "code_block") {
        const info = anyNode.info ? String(anyNode.info).trim() : "";
        const lines = Array.isArray(anyNode.children)
          ? anyNode.children.map((child: Node) => SlateNode.string(child))
          : [];
        const fence = "```" + info;
        return [fence, ...lines, "```"].join("\n");
      }
      return SlateNode.string(node);
    })
    .join("\n\n");
}
