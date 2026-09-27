/** @jest-environment jsdom */

import { useLayoutEffect, useRef, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { createEditor } from "slate";
import { Editable, Slate, withReact } from "../slate-react";

function Editor({ autoFocus = true }: { autoFocus?: boolean }) {
  const [editor] = useState(() => withReact(createEditor()));
  return (
    <Slate
      editor={editor}
      value={[{ type: "paragraph", children: [{ text: "Draft" }] }]}
      onChange={() => {}}
    >
      <Editable aria-label="Chat draft" autoFocus={autoFocus} />
    </Slate>
  );
}

function Dialog({ children }: { children?: React.ReactNode }) {
  const search = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    search.current?.focus();
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label="Collaborators">
      <input ref={search} aria-label="Search collaborators" />
      {children}
    </div>
  );
}

it("autofocuses the editor without a dialog", () => {
  render(<Editor />);
  expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveFocus();
});

it("does not focus when autofocus is disabled", () => {
  render(<Editor autoFocus={false} />);
  expect(screen.getByRole("textbox", { name: "Chat draft" })).not.toHaveFocus();
});

it("does not steal dialog focus when the chat editor finishes mounting", () => {
  const view = render(<Dialog />);
  const search = screen.getByRole("textbox", { name: "Search collaborators" });
  expect(search).toHaveFocus();
  view.rerender(
    <>
      <Dialog />
      <Editor />
    </>,
  );
  expect(search).toHaveFocus();

  // Only automatic initialization is guarded, not explicit user refocusing.
  const editor = screen.getByRole("textbox", { name: "Chat draft" });
  act(() => editor.focus());
  expect(editor).toHaveFocus();
});

it("checks dialog ownership at focus time, after render", () => {
  render(
    <>
      <Editor />
      <Dialog />
    </>,
  );
  expect(
    screen.getByRole("textbox", { name: "Search collaborators" }),
  ).toHaveFocus();
});

it("allows autofocus for an editor inside the active dialog", () => {
  render(
    <Dialog>
      <Editor />
    </Dialog>,
  );
  expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveFocus();
});
