/**
 * Playwright harness for Slate.
 *
 * This file mounts a minimal Slate editor inside a tiny HTML page so
 * Playwright can drive real DOM input (typing, selection, Enter, etc.).
 * It also exposes a small `window.__slateTest` API that tests can query
 * to read editor state or trigger a few editor operations without poking
 * deep into the app. Keep this harness lightweight and deterministic so
 * flaky behavior is easy to spot.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { createEditor, Descendant, Editor, Node, Range, Transforms } from "slate";

import { Editable, Slate, withReact } from "../slate-react";
import { HAS_BEFORE_INPUT_SUPPORT } from "../slate-react/utils/environment";
import { withDeleteBackward } from "../format/delete-backward";
import { autoformatBlockquoteAtStart } from "../format/auto-format-quote";
import { handleBlankLineEnter } from "../keyboard/blank-line-enter";

declare global {
  interface Window {
    __slateTest?: {
      getText: () => string;
      getSelection: () => Range | null;
      getValue: () => Descendant[];
      getEnv: () => { hasBeforeInput: boolean };
      insertText: (text: string, autoFormat?: boolean) => void;
      insertBreak: () => void;
      setSelection: (range: Range) => void;
      setValue: (value: Descendant[]) => void;
    };
  }
}

const initialValue: Descendant[] = [
  { type: "paragraph", children: [{ text: "" }] },
];

function Harness(): React.JSX.Element {
  const editor = useMemo(
    () => withDeleteBackward(withReact(createEditor())),
    [],
  );
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    window.__slateTest = {
      getText: () => Node.string(editor),
      getSelection: () => editor.selection,
      getValue: () => valueRef.current,
      setSelection: (range) => {
        Transforms.select(editor, range);
      },
      setValue: (nextValue) => {
        setValue(nextValue);
      },
      insertText: (text, autoFormat) => {
        if (autoFormat == null) {
          Editor.insertText(editor, text);
          return;
        }
        if (text === " ") {
          if (autoformatBlockquoteAtStart(editor)) {
            return;
          }
          Editor.insertText(editor, text);
          autoformatBlockquoteAtStart(editor);
          return;
        }
        Editor.insertText(editor, text);
      },
      insertBreak: () => {
        Editor.insertBreak(editor);
      },
      getEnv: () => ({
        hasBeforeInput: HAS_BEFORE_INPUT_SUPPORT,
      }),
    };
  }, [editor]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (handleBlankLineEnter(editor)) {
          event.preventDefault();
        }
      }
    },
    [editor],
  );

  return (
    <Slate editor={editor} value={value} onChange={setValue}>
      <Editable placeholder="Type here..." onKeyDown={onKeyDown} />
    </Slate>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing harness root element");
}

ReactDOM.createRoot(root).render(<Harness />);
