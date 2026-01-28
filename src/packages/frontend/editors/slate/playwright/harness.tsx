/**
 * Playwright harness for Slate.
 *
 * This file mounts a minimal Slate editor inside a tiny HTML page so
 * Playwright can drive real DOM input (typing, selection, Enter, etc.).
 * It also exposes a small `window.__slateTest` API that tests can query
 * to read editor state or trigger a few editor operations without poking
 * deep into the app. Keep this harness lightweight and deterministic so
 * flaky behavior is easy to spot.
 *
 * IMPORTANT: Avoid importing modules that pull in the full @cocalc/frontend
 * bundle or markdown pipeline. The Playwright harness is bundled by esbuild
 * in the test web server; heavy imports drag in node-only deps, assets, and
 * CSS/font loaders that are not configured here. If you need behavior for
 * a test, implement a tiny local helper in this file instead.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { createEditor, Descendant, Editor, Node, Range, Transforms } from "slate";

import { Editable, Slate, withReact, ReactEditor } from "../slate-react";
import BlockMarkdownEditor from "../block-markdown-editor-core";
import "./elements-types-shim";
import { HAS_BEFORE_INPUT_SUPPORT } from "../slate-utils/environment";
import { autoformatBlockquoteAtStart } from "../format/auto-format-quote";
import { handleBlankLineEnter } from "../keyboard/blank-line-enter";
import { getHandler } from "../keyboard/register";
import { getGapCursor } from "../gap-cursor";
import { withIsInline, withIsVoid } from "../plugins";
import "../keyboard/arrow-keys";
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
    __slateBlockTest?: {
      getMarkdown: () => string;
    };
  }
}

const initialValue: Descendant[] = [
  { type: "paragraph", children: [{ text: "" }] },
];

// Provide lightweight polyfills so block-mode virtualization can mount in tests.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as any).ResizeObserver = ResizeObserver;
  }
  if (!("IntersectionObserver" in window)) {
    class IntersectionObserver {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    (window as any).IntersectionObserver = IntersectionObserver;
  }
}

function Harness(): React.JSX.Element {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const blockMode = params.get("block") === "1";
  const initialMarkdown = "a\n\n```\nfoo\n```\n";

  const editor = useMemo(
    () => withIsInline(withIsVoid(withReact(createEditor()))),
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
          inlineAutoformatAtCursor(editor);
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

  if (blockMode) {
    const getValueRef = useRef<() => string>(() => "");
    useEffect(() => {
      window.__slateBlockTest = {
        getMarkdown: () => getValueRef.current?.() ?? "",
      };
    }, []);
    return (
      <HarnessErrorBoundary>
        <div style={{ padding: 16, width: 520, height: 320 }}>
          <BlockMarkdownEditor
            value={initialMarkdown}
            read_only={false}
            hidePath={true}
            minimal={true}
            height="300px"
            noVfill={true}
            actions={{}}
            getValueRef={getValueRef}
          />
        </div>
      </HarnessErrorBoundary>
    );
  }

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        event.key === " " &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        Editor.insertText(editor, " ");
        inlineAutoformatAtCursor(editor);
        return;
      }
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
                        const doc = markdownToSlateForHarness(codeValue ?? "");
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

class HarnessErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  componentDidCatch(error: Error): void {
    console.error("Block harness error:", error);
    this.setState({ error });
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const message =
        this.state.error?.message ?? String(this.state.error);
      return (
        <pre data-testid="harness-error">
          {message}
        </pre>
      );
    }
    return this.props.children;
  }
}

function markdownToSlateForHarness(markdown: string): Descendant[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const items = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "))
    .map((line) => ({
      type: "list_item",
      children: [
        {
          type: "paragraph",
          children: [{ text: line.slice(2) }],
        },
      ],
    }));

  if (items.length === 0) {
    return [{ type: "paragraph", children: [{ text: markdown }] }] as any;
  }

  return [
    {
      type: "bullet_list",
      tight: true,
      children: items,
    } as any,
  ];
}

function inlineAutoformatAtCursor(editor: Editor): void {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) {
    return;
  }
  const focus = selection.focus;
  let entry;
  try {
    entry = Editor.node(editor, focus.path);
  } catch {
    return;
  }
  const [node, path] = entry as [any, any];
  if (typeof node?.text !== "string") {
    return;
  }

  const text = node.text;
  const before = text.slice(0, focus.offset);
  const after = text.slice(focus.offset);
  if (!before.endsWith(" ")) {
    return;
  }
  const beforeNoSpace = before.slice(0, -1);

  const codeMatch = beforeNoSpace.match(/`([^`]+)`$/);
  const boldMatch = beforeNoSpace.match(/\*\*([^*]+)\*\*$/);

  if (!codeMatch && !boldMatch) {
    return;
  }

  const replacement = codeMatch ? codeMatch[1] : boldMatch?.[1] ?? "";
  const newText =
    beforeNoSpace.replace(/(`[^`]+`|\*\*[^*]+\*\*)$/, replacement) +
    " " +
    after;

  Transforms.delete(editor, {
    at: {
      anchor: { path, offset: 0 },
      focus: { path, offset: text.length },
    },
  });
  Transforms.insertText(editor, newText, { at: { path, offset: 0 } });
  const point = { path, offset: newText.length - after.length };
  Transforms.select(editor, { anchor: point, focus: point });
  ReactEditor.focus(editor as ReactEditor);
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing harness root element");
}

ReactDOM.createRoot(root).render(<Harness />);
