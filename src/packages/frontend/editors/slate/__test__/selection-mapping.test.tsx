import { render } from "@testing-library/react";
import { createEditor, Descendant, Range } from "slate";

import {
  Editable,
  ReactEditor,
  RenderElementProps,
  Slate,
  withReact,
} from "../slate-react";

const renderElement = ({ attributes, children, element }: RenderElementProps) => {
  const Tag = element.type === "paragraph" ? "p" : "div";
  return <Tag {...attributes}>{children}</Tag>;
};

test("slate selection mapping handles zero-width and void nodes", () => {
  const editor = withReact(createEditor());
  editor.isVoid = (element) => element.type === "void";

  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "hello" }] },
    { type: "paragraph", children: [{ text: "" }] },
    { type: "void", children: [{ text: "" }] },
  ];

  const { unmount } = render(
    <Slate editor={editor} value={value} onChange={() => undefined}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );

  const points = [
    { path: [0, 0], offset: 2 },
    { path: [1, 0], offset: 0 },
    { path: [2, 0], offset: 0 },
  ];

  for (const point of points) {
    const domPoint = ReactEditor.toDOMPoint(editor, point);
    const roundTripPoint = ReactEditor.toSlatePoint(editor, domPoint);
    expect(roundTripPoint).toEqual(point);

    const range: Range = { anchor: point, focus: point };
    const domRange = ReactEditor.toDOMRange(editor, range);
    const roundTripRange = ReactEditor.toSlateRange(editor, domRange);
    expect(roundTripRange).toEqual(range);
  }

  unmount();
});
