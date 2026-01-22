import { render } from "@testing-library/react";
import { createEditor, Descendant, Range } from "slate";

import {
  Editable,
  ReactEditor,
  RenderElementProps,
  Slate,
  withReact,
} from "../slate-react";
import { createMentionStatic } from "../elements/mention";

const INLINE_TYPES = new Set(["link", "mention"]);

const renderElement = ({ attributes, children, element }: RenderElementProps) => {
  const Tag =
    element.type === "paragraph"
      ? "p"
      : INLINE_TYPES.has(element.type)
        ? "span"
        : "div";
  return <Tag {...attributes}>{children}</Tag>;
};

test("slate selection mapping handles zero-width and void nodes", () => {
  const editor = withReact(createEditor());
  editor.isVoid = (element) => element.type === "hr";

  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "hello" }] },
    { type: "paragraph", children: [{ text: "" }] },
    { type: "hr", children: [{ text: "" }] },
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

test("slate selection mapping works with placeholders", () => {
  const editor = withReact(createEditor());
  editor.isVoid = (element) => element.type === "hr";

  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "" }] },
  ];

  const { unmount } = render(
    <Slate editor={editor} value={value} onChange={() => undefined}>
      <Editable renderElement={renderElement} placeholder="Type here..." />
    </Slate>,
  );

  const point = { path: [0, 0], offset: 0 };
  const domPoint = ReactEditor.toDOMPoint(editor, point);
  const roundTripPoint = ReactEditor.toSlatePoint(editor, domPoint);
  expect(roundTripPoint).toEqual(point);

  const range: Range = { anchor: point, focus: point };
  const domRange = ReactEditor.toDOMRange(editor, range);
  const roundTripRange = ReactEditor.toSlateRange(editor, domRange);
  expect(roundTripRange).toEqual(range);

  unmount();
});

test("slate selection mapping handles inline void nodes", () => {
  const editor = withReact(createEditor());
  editor.isVoid = (element) => element.type === "mention";
  editor.isInline = (element) => element.type === "mention";

  const value: Descendant[] = [
    {
      type: "paragraph",
      children: [
        { text: "hi " },
        createMentionStatic("account-123", "User"),
        { text: "there" },
      ],
    },
  ];

  const { unmount } = render(
    <Slate editor={editor} value={value} onChange={() => undefined}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );

  const points = [
    { path: [0, 0], offset: 3 },
    { path: [0, 1, 0], offset: 0 },
    { path: [0, 2], offset: 2 },
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

test("slate selection mapping round-trips ranges across inline nodes", () => {
  const editor = withReact(createEditor());
  editor.isInline = (element) => element.type === "link";

  const value: Descendant[] = [
    {
      type: "paragraph",
      children: [
        { text: "prefix " },
        { type: "link", isInline: true, children: [{ text: "link" }] },
        { text: " suffix" },
      ],
    },
  ];

  const { unmount } = render(
    <Slate editor={editor} value={value} onChange={() => undefined}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );

  const ranges: Range[] = [
    {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 1, 0], offset: 2 },
    },
    {
      anchor: { path: [0, 1, 0], offset: 1 },
      focus: { path: [0, 2], offset: 4 },
    },
  ];

  for (const range of ranges) {
    const domRange = ReactEditor.toDOMRange(editor, range);
    const roundTripRange = ReactEditor.toSlateRange(editor, domRange);
    expect(roundTripRange).toEqual(range);
  }

  unmount();
});
