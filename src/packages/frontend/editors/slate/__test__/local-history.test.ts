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

test.each([false, true])(
  "does not partially apply a stale history batch (redo=%s)",
  (shiftKey) => {
    const editor = withHistory(createEditor());
    editor.children = [{ type: "paragraph", children: [{ text: "hello!" }] }];
    const operations = [
      {
        type: "insert_text" as const,
        path: [2, 0],
        offset: 0,
        text: "x",
      },
      {
        type: "insert_text" as const,
        path: [0, 0],
        offset: 5,
        text: "!",
      },
    ];
    editor.history[shiftKey ? "redos" : "undos"].push({
      operations: shiftKey ? operations.slice().reverse() : operations,
      selectionBefore: null,
    });
    const children = editor.children;

    expect(handleLocalHistoryHotkey(event(shiftKey), editor, true)).toBe(true);
    expect(editor.children).toBe(children);
    expect(Editor.string(editor, [])).toBe("hello!");
    expect(editor.operations).toEqual([]);
    expect(editor.history).toEqual({ undos: [], redos: [] });
  },
);

test("does not swallow an error from the live editor's undo", () => {
  const editor = withHistory(createEditor());
  editor.children = [{ type: "paragraph", children: [{ text: "hello" }] }];
  Transforms.select(editor, Editor.end(editor, []));
  editor.insertText("!");
  const failure = new Error("live editor failure");
  editor.undo = () => {
    throw failure;
  };

  expect(() => handleLocalHistoryHotkey(event(), editor, true)).toThrow(
    failure,
  );
  expect(Editor.string(editor, [])).toBe("hello!");
  expect(editor.history.undos).toHaveLength(1);
});
