import React from "react";
import { act, render, screen } from "@testing-library/react";
import { createEditor, Transforms } from "slate";
import { mentionQueryAtCursor, useMentions } from "./hook";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useIsMountedRef: () => React.useRef(true),
}));
jest.mock("../slate-react", () => ({
  ReactEditor: {
    toDOMRange: () => ({
      getBoundingClientRect: () => ({ bottom: 0, left: 0, width: 0 }),
    }),
    focus: jest.fn(),
  },
}));
jest.mock("@cocalc/frontend/editors/markdown-input/complete", () => ({
  Complete: ({ items }) => (
    <div role="listbox" aria-label="Mention choices">
      {items.map((item) => (
        <div role="option" aria-selected={false} key={item.value}>
          {item.label}
        </div>
      ))}
    </div>
  ),
}));

test.each([
  "@",
  "@review-",
  "ask @review-agent",
  "(@review-agent",
  "ask @review-agent ",
])("hyphenated cursor query: %s", (text) => {
  const offset = text.trimEnd().length;
  expect(mentionQueryAtCursor(text, offset)?.search).toBe(
    text.slice(text.lastIndexOf("@") + 1).trimEnd(),
  );
});
test.each(["person@review-agent", "https://site/@review-agent", "hello"])(
  "non-mention cursor text: %s",
  (text) => {
    expect(mentionQueryAtCursor(text, text.length)).toBeUndefined();
  },
);

test("typing after a hyphen keeps the picker open and asynchronous provider refresh updates choices", async () => {
  jest.useFakeTimers();
  const editor = createEditor();
  editor.children = [
    { type: "paragraph", children: [{ text: "ask @review-" }] },
  ] as any;
  Transforms.select(editor, { path: [0, 0], offset: "ask @review-".length });
  let change: () => void = () => {};
  const matching = jest.fn(() => [] as any[]);
  function Harness({ provider }) {
    const mentions = useMentions({
      editor: editor as any,
      insertMention: jest.fn(),
      matchingUsers: provider,
      isVisible: true,
    });
    change = mentions.onChange;
    return <>{mentions.Mentions}</>;
  }
  const view = render(<Harness provider={matching} />);
  act(() => {
    change();
    jest.advanceTimersByTime(251);
  });
  expect(matching).toHaveBeenLastCalledWith("review-");
  expect(screen.getByRole("listbox", { name: "Mention choices" })).toBeTruthy();
  act(() => {
    Transforms.insertText(editor, "agent");
    change();
    jest.advanceTimersByTime(251);
  });
  expect(matching).toHaveBeenLastCalledWith("review-agent");
  const refreshed = jest.fn(() => [
    { value: "stable-agent-reference", label: "@review-agent" },
  ]);
  view.rerender(<Harness provider={refreshed} />);
  expect(refreshed).toHaveBeenLastCalledWith("review-agent");
  expect(screen.getByRole("option", { name: "@review-agent" })).toBeTruthy();
  view.unmount();
  jest.useRealTimers();
});
