import "../elements/types";

import { render } from "@testing-library/react";
import { createEditor, Descendant, Editor, Element, Transforms } from "slate";

import { Element as SlateElement } from "../element";
import { Editable, Slate, withReact } from "../slate-react";
import { markdownAutoformat } from "../format/auto-format";

const renderElement = (props) => <SlateElement {...props} />;

test("autoformat list does not leave a blank paragraph between blocks", () => {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "foo" }] },
    { type: "paragraph", children: [{ text: "-" }] },
  ];

  const { unmount } = render(
    <Slate editor={editor} value={value} onChange={() => undefined}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );

  Transforms.select(editor, { path: [1, 0], offset: 1 });
  const didFormat = markdownAutoformat(editor as any);

  expect(didFormat).toBe(true);
  expect(editor.children).toHaveLength(2);
  expect(editor.children[0]?.["type"]).toBe("paragraph");
  expect(editor.children[1]?.["type"]).toBe("bullet_list");
  expect(
    editor.children.some(
      (node) => node["type"] === "paragraph" && node["blank"] === true,
    ),
  ).toBe(false);
  expect(editor.selection).not.toBeNull();
  if (editor.selection) {
    const listEntry = Editor.above(editor, {
      at: editor.selection.focus,
      match: (node) =>
        Element.isElement(node) &&
        (node.type === "bullet_list" || node.type === "ordered_list"),
    });
    expect(listEntry).toBeDefined();
  }

  unmount();
});
