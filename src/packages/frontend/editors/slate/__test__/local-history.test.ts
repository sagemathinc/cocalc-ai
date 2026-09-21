import { createEditor, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { handleLocalHistoryHotkey } from "../local-history";

function event(shiftKey = false) {
  return {
    altKey: false,
    ctrlKey: false,
    key: "z",
    metaKey: true,
    shiftKey,
  };
}

test("command-z and command-shift-z use Slate local history", () => {
  const editor = withHistory(createEditor());
  editor.children = [{ type: "paragraph", children: [{ text: "hello" }] }];
  Transforms.select(editor, Editor.end(editor, []));
  editor.insertText("!");

  expect(Editor.string(editor, [])).toBe("hello!");
  expect(handleLocalHistoryHotkey(event(), editor, true)).toBe(true);
  expect(Editor.string(editor, [])).toBe("hello");
  expect(handleLocalHistoryHotkey(event(true), editor, true)).toBe(true);
  expect(Editor.string(editor, [])).toBe("hello!");
});

test("local history does not claim unrelated shortcuts", () => {
  const editor = withHistory(createEditor());

  expect(handleLocalHistoryHotkey({ ...event(), key: "y" }, editor, true)).toBe(
    false,
  );
  expect(handleLocalHistoryHotkey(event(), editor, false)).toBe(false);
});

test.each([
  [false, "undos"],
  [true, "redos"],
] as const)(
  "discards stale local history instead of crashing on %s",
  (shiftKey, stack) => {
    const editor = withHistory(createEditor());
    editor.children = [{ type: "paragraph", children: [{ text: "hello" }] }];
    editor.history[stack].push({
      operations: [
        {
          type: shiftKey ? "remove_text" : "insert_text",
          path: [2, 0],
          offset: 0,
          text: "x",
        },
      ],
      selectionBefore: null,
    });

    expect(handleLocalHistoryHotkey(event(shiftKey), editor, true)).toBe(true);
    expect(Editor.string(editor, [])).toBe("hello");
    expect(editor.history).toEqual({ undos: [], redos: [] });
  },
);
