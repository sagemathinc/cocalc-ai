import "../keyboard/actions";

import { createEditor } from "slate";
import { withReact } from "../slate-react";
import { getHandler } from "../keyboard/register";

test("ctrl+shift+> increases font size", () => {
  const editor = withReact(createEditor());
  const changeFontSize = jest.fn();
  const handler = getHandler({
    key: ">",
    shiftKey: true,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor: editor as any,
    extra: { actions: { change_font_size: changeFontSize }, id: "", search: {} as any },
  });
  expect(changeFontSize).toHaveBeenCalledWith(1);
});

test("ctrl+shift+< decreases font size", () => {
  const editor = withReact(createEditor());
  const changeFontSize = jest.fn();
  const handler = getHandler({
    key: "<",
    shiftKey: true,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
  });
  expect(handler).toBeTruthy();
  handler?.({
    editor: editor as any,
    extra: { actions: { change_font_size: changeFontSize }, id: "", search: {} as any },
  });
  expect(changeFontSize).toHaveBeenCalledWith(-1);
});
