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
  return slate.map((node) => SlateNode.string(node)).join("\n\n");
}
