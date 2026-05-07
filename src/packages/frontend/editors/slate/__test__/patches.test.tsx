import "../elements/types";
import "../patches";

import { createEditor, Descendant, Node } from "slate";

describe("Slate patches", () => {
  it("keeps Node.leaf nonfatal for stale paths", () => {
    const editor = createEditor();
    const value: Descendant[] = [
      {
        type: "bullet_list",
        children: [
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "bar" }] }],
          },
        ],
      },
    ];
    editor.children = value;

    const leaf = Node.leaf(editor, [999, 999]);
    expect(leaf.text).toBe("bar");
  });

  it("keeps Node.leaf nonfatal for non-leaf paths", () => {
    const editor = createEditor();
    const value: Descendant[] = [
      {
        type: "bullet_list",
        children: [
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "first" }] }],
          },
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "second" }] }],
          },
        ],
      },
    ];
    editor.children = value;

    const leaf = Node.leaf(editor, [0]);
    expect(leaf.text).toBe("first");
  });
});
