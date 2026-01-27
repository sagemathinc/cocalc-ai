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

import { Editable, Slate, withReact, ReactEditor } from "../slate-react";
import { HAS_BEFORE_INPUT_SUPPORT } from "../slate-utils/environment";
import { withDeleteBackward } from "../format/delete-backward";
import { autoformatBlockquoteAtStart } from "../format/auto-format-quote";
import { handleBlankLineEnter } from "../keyboard/blank-line-enter";
import { getHandler } from "../keyboard/register";
import { getGapCursor } from "../gap-cursor";
import { withIsInline, withIsVoid } from "../plugins";
import "../keyboard/arrow-keys";
import { markdown_to_slate } from "../markdown-to-slate";
import { getCodeBlockText } from "../elements/code-block/utils";

declare global {
  interface Window {
    __slateTest?: {
      getText: () => string;
      getSelection: () => Range | null;
      getValue: () => Descendant[];
      getGapCursor: () => any;
      isFocused: () => boolean;
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
    () =>
      withDeleteBackward(
        withIsInline(withIsVoid(withReact(createEditor()))),
      ),
    [],
  );
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const valueRef = useRef(value);

  const handleChange = useCallback((nextValue: Descendant[]) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  }, []);

  useEffect(() => {
    window.__slateTest = {
      getText: () => Node.string(editor),
      getSelection: () => editor.selection,
      getValue: () => valueRef.current,
      getGapCursor: () => getGapCursor(editor),
      isFocused: () => ReactEditor.isFocused(editor),
      setSelection: (range) => {
        Transforms.select(editor, range);
      },
      setValue: (nextValue) => {
        editor.children = nextValue;
        editor.onChange();
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
      const handler = getHandler(event);
      if (handler) {
        const handled = handler({ editor: editor as any, extra: { actions: {}, id: "", search: {} as any } });
        if (handled) {
          event.preventDefault();
        }
      }
    },
    [editor],
  );

  return (
    <Slate editor={editor} value={value} onChange={handleChange}>
      <div
        style={{
          width: 400,
          fontSize: 16,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          lineHeight: 1.3,
          padding: 16,
          border: "1px solid #ddd",
        }}
      >
        <Editable
          placeholder="Type here..."
          onKeyDown={onKeyDown}
          renderElement={({ attributes, children, element }) => {
            if ((element as any).isVoid) {
              return (
                <div
                  {...attributes}
                  data-testid="void-block"
                  contentEditable={false}
                  style={{ margin: "6px 0" }}
                >
                  {children}
                </div>
              );
            }
            if (element.type === "code_line") {
              return (
                <div
                  {...attributes}
                  className="cocalc-slate-code-line"
                  style={{ position: "relative" }}
                >
                  {children}
                </div>
              );
            }
            if (element.type === "code_block") {
              const codeElement = element as any;
              const codeValue = getCodeBlockText(codeElement);
              return (
                <div
                  {...attributes}
                  data-testid="code-block"
                  style={{
                    border: "1px solid #999",
                    padding: "8px",
                    margin: "8px 0",
                    minHeight: 24,
                  }}
                >
                  {codeElement.markdownCandidate && (
                    <button
                      data-testid="convert-markdown"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const doc = markdown_to_slate(codeValue ?? "", true);
                        Editor.withoutNormalizing(editor, () => {
                          const path = ReactEditor.findPath(editor, codeElement);
                          Transforms.removeNodes(editor, { at: path });
                          Transforms.insertNodes(editor, doc as any, { at: path });
                        });
                      }}
                    >
                      Convert to rich text
                    </button>
                  )}
                  <div className="cocalc-slate-code-block">{children}</div>
                </div>
              );
            }
            return (
              <p {...attributes} style={{ margin: "6px 0" }}>
                {children}
              </p>
            );
          }}
        />
      </div>
    </Slate>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing harness root element");
}

ReactDOM.createRoot(root).render(<Harness />);
