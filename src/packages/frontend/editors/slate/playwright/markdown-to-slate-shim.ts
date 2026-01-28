import type { Descendant } from "slate";

export function markdown_to_slate(markdown: string): Descendant[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nodes: Descendant[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const info = line.slice(3).trim();
      i += 1;
      const codeLines: Descendant[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push({
          type: "code_line",
          children: [{ text: lines[i] }],
        } as any);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith("```")) {
        i += 1;
      }
      if (codeLines.length === 0) {
        codeLines.push({ type: "code_line", children: [{ text: "" }] } as any);
      }
      nodes.push({
        type: "code_block",
        fence: true,
        info,
        children: codeLines,
      } as any);
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      const items: Descendant[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        const itemText = lines[i].slice(2);
        items.push({
          type: "list_item",
          children: [
            {
              type: "paragraph",
              children: [{ text: itemText }],
            },
          ],
        } as any);
        i += 1;
      }
      nodes.push({
        type: "bullet_list",
        tight: true,
        children: items,
      } as any);
      continue;
    }

    nodes.push({ type: "paragraph", children: [{ text: line }] } as any);
    i += 1;
  }

  if (nodes.length === 0) {
    return [{ type: "paragraph", children: [{ text: "" }] }] as any;
  }

  return nodes;
}
