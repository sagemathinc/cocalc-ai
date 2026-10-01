/** @jest-environment jsdom */

import { autofocusEditor } from "./autofocus";

afterEach(() => {
  document.body.replaceChildren();
});

it.each(["dialog", "alertdialog"])(
  "respects focus in a %s at the moment autofocus is requested",
  (role) => {
    const editor = document.createElement("textarea");
    document.body.append(editor);
    const finishInitialization = () => autofocusEditor(editor);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", role);
    const search = document.createElement("input");
    dialog.append(search);
    document.body.append(dialog);
    search.focus();

    expect(finishInitialization()).toBe(false);
    expect(search).toHaveFocus();
    dialog.append(editor);
    expect(finishInitialization()).toBe(true);
    expect(editor).toHaveFocus();
  },
);

it("respects the innermost focused dialog", () => {
  const outer = document.createElement("div");
  outer.setAttribute("role", "dialog");
  const editor = document.createElement("textarea");
  const inner = document.createElement("div");
  inner.setAttribute("role", "dialog");
  const search = document.createElement("input");
  inner.append(search);
  outer.append(editor, inner);
  document.body.append(outer);
  search.focus();

  expect(autofocusEditor(editor)).toBe(false);
  expect(search).toHaveFocus();
});

it("does not retry a suppressed autofocus after the dialog closes", () => {
  jest.useFakeTimers();
  try {
    const editor = document.createElement("textarea");
    const dialog = document.createElement("dialog");
    dialog.open = true;
    const search = document.createElement("input");
    dialog.append(search);
    document.body.append(editor, dialog);
    search.focus();
    expect(autofocusEditor(editor)).toBe(false);
    dialog.remove();
    jest.runOnlyPendingTimers();
    expect(editor).not.toHaveFocus();
    expect(autofocusEditor(editor, { preventScroll: true })).toBe(true);
    expect(editor).toHaveFocus();
  } finally {
    jest.useRealTimers();
  }
});

it("ignores a disconnected editor", () => {
  const editor = document.createElement("textarea");
  const focus = jest.spyOn(editor, "focus");
  expect(autofocusEditor(editor)).toBe(false);
  expect(focus).not.toHaveBeenCalled();
});
