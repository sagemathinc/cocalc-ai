import type { Descendant } from "slate";

export function markdown_to_slate(markdown: string): Descendant[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "))
    .map((line) => ({
      type: "list_item",
      children: [
        {
          type: "paragraph",
          children: [{ text: line.slice(2) }],
        },
      ],
    }));

  if (items.length === 0) {
    return [{ type: "paragraph", children: [{ text: markdown }] }] as any;
  }

  return [
    {
      type: "bullet_list",
      tight: true,
      children: items,
    } as any,
  ];
}
