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
/* eslint-disable react-hooks/rules-of-hooks */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom/client";
import {
  createEditor,
  Descendant,
  Editor,
  Node,
  Range,
  Transforms,
} from "slate";

import { Editable, Slate, withReact, ReactEditor } from "../slate-react";
import BlockMarkdownEditor from "../block-markdown-editor-core";
import { EditableMarkdown } from "../editable-markdown";
import {
  FrameContext,
  defaultFrameContext,
} from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import "./elements-types-shim";
import { HAS_BEFORE_INPUT_SUPPORT } from "../slate-utils/environment";
import { withInsertText } from "../format/insert-text";
import { handleBlankLineEnter } from "../keyboard/blank-line-enter";
import { getHandler } from "../keyboard/register";
import { withIsInline, withIsVoid } from "../plugins";
import "../keyboard/arrow-keys";
import { getCodeBlockText } from "../elements/code-block/utils";

declare global {
  interface Window {
    __slateTest?: {
      getText: () => string;
      getSelection: () => Range | null;
      getValue: () => Descendant[];
      isFocused: () => boolean;
      getEnv: () => { hasBeforeInput: boolean };
      insertText: (text: string, autoFormat?: boolean) => void;
      insertBreak: () => void;
      setSelection: (range: Range) => void;
      setValue: (value: Descendant[]) => void;
    };
    __slateBlockTest?: {
      getMarkdown: () => string;
      setMarkdown?: (value: string) => void;
      setSelection?: (index: number, position?: "start" | "end") => boolean;
      setSelectionFromMarkdownPosition?: (pos: {
        line: number;
        ch: number;
      }) => boolean;
      getSelection?: () => { index: number; selection: Range } | null;
      getSelectionForBlock?: (
        index: number,
      ) => { index: number; selection: Range } | null;
      getSelectionOffsetForBlock?: (
        index: number,
      ) => { offset: number; text: string } | null;
      getBlocks?: () => string[];
      getFocusedIndex?: () => number | null;
    };
    __slateCollabTest?: {
      getMarkdownA: () => string;
      getMarkdownB: () => string;
      setRemote: (value: string) => void;
      setSelectionA: (
        range: Range | number,
        position?: "start" | "end",
      ) => boolean | void;
      setSelectionB: (
        range: Range | number,
        position?: "start" | "end",
      ) => boolean | void;
      setSelectionFromMarkdownA?: (pos: {
        line: number;
        ch: number;
      }) => boolean;
      setSelectionFromMarkdownB?: (pos: {
        line: number;
        ch: number;
      }) => boolean;
      getBlocksA?: () => string[];
      getBlocksB?: () => string[];
      getSelectionA: () => Range | null;
      getSelectionB: () => Range | null;
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
  if (!("$$" in window)) {
    (window as any).$ = (_arg?: any) => ({
      scrollTop: (_value?: number) => undefined,
      find: () => ({ on: () => undefined }),
    });
  }
}

function Harness(): React.JSX.Element {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const blockMode = params.get("block") === "1";
  const collabBlockMode = params.get("collabBlock") === "1";
  const collabMode = params.get("collab") === "1";
  const autoformatMode = params.get("autoformat") === "1";
  const searchParams =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search);
  const initialMarkdown =
    searchParams?.get("md") != null
      ? decodeURIComponent(searchParams.get("md") || "")
      : "a";

  const editor = useMemo(() => {
    const base = withIsInline(withIsVoid(withReact(createEditor())));
    if (autoformatMode) {
      const withAutoformat = withInsertText(base);
      (withAutoformat as any).__autoformatMode = true;
      return withAutoformat;
    }
    return base;
  }, [autoformatMode]);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const valueRef = useRef(value);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: ErrorEvent) => {
      (window as any).__slateHarnessError = {
        message: event?.message ?? "unknown error",
        stack: event?.error?.stack ?? "",
      };
    };
    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }, []);

  const handleChange = useCallback((nextValue: Descendant[]) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  }, []);

  useLayoutEffect(() => {
    if ((editor as any).__autoformatMode) {
      (editor as any).bumpChange = () => {
        const snapshot = [...valueRef.current];
        valueRef.current = snapshot;
        setValue(snapshot);
      };
    }
    return () => {
      if ((editor as any).__autoformatMode) {
        delete (editor as any).bumpChange;
      }
    };
  }, [editor, autoformatMode]);

  useEffect(() => {
    window.__slateTest = {
      getText: () => Node.string(editor),
      getSelection: () => editor.selection,
      getValue: () => valueRef.current,
      isFocused: () => ReactEditor.isFocused(editor),
      setSelection: (range) => {
        Transforms.select(editor, range);
      },
      setValue: (nextValue) => {
        editor.children = nextValue;
        editor.onChange();
      },
      insertText: (text, autoFormat) => {
        // Use editor.insertText to exercise autoformat logic when enabled.
        // @ts-ignore - insertText accepts a second autoformat flag in our editor.
        editor.insertText(text, autoFormat);
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
    const controlRef = useRef<any>(null);
    useEffect(() => {
      const api: Window["__slateBlockTest"] = {
        getMarkdown: () => getValueRef.current?.() ?? "",
        setMarkdown: (value: string) => {
          controlRef.current?.setMarkdown?.(value);
        },
        setSelection: (index: number, position: "start" | "end" = "start") => {
          return controlRef.current?.setSelectionInBlock?.(index, position);
        },
        getSelection: () => {
          return controlRef.current?.getSelectionInBlock?.();
        },
        getSelectionForBlock: (index: number) => {
          return controlRef.current?.getSelectionForBlock?.(index);
        },
        getSelectionOffsetForBlock: (index: number) => {
          return (
            controlRef.current?.getSelectionOffsetForBlock?.(index) ?? null
          );
        },
        getBlocks: () => {
          return controlRef.current?.getBlocks?.() ?? [];
        },
        getFocusedIndex: () => {
          return controlRef.current?.getFocusedIndex?.() ?? null;
        },
        setSelectionFromMarkdownPosition: (pos: {
          line: number;
          ch: number;
        }) => {
          return (
            controlRef.current?.setSelectionFromMarkdownPosition?.(pos) ?? false
          );
        },
      };
      window.__slateBlockTest = api;
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
            controlRef={controlRef}
            disableVirtualization={true}
          />
        </div>
      </HarnessErrorBoundary>
    );
  }

  if (collabBlockMode) {
    class FakeSyncstring {
      value: string;
      listeners: Set<() => void>;
      constructor(initial: string) {
        this.value = initial;
        this.listeners = new Set();
      }
      to_str() {
        return this.value;
      }
      set(value: string) {
        this.value = value;
        this.emit();
      }
      on(event: string, cb: () => void) {
        if (event === "change") {
          this.listeners.add(cb);
        }
      }
      removeListener(event: string, cb: () => void) {
        if (event === "change") {
          this.listeners.delete(cb);
        }
      }
      emit() {
        for (const cb of this.listeners) {
          cb();
        }
      }
    }

    const [markdown, setMarkdown] = useState<string>(
      "alpha\n\nbeta\n\ncharlie\n",
    );
    const syncRef = useRef(new FakeSyncstring(markdown));
    const getValueRefA = useRef<() => string>(() => "");
    const getValueRefB = useRef<() => string>(() => "");
    const controlRefA = useRef<any>(null);
    const controlRefB = useRef<any>(null);

    useEffect(() => {
      window.__slateCollabTest = {
        getMarkdownA: () => getValueRefA.current?.() ?? "",
        getMarkdownB: () => getValueRefB.current?.() ?? "",
        setRemote: (value) => {
          syncRef.current.set(value);
        },
        setSelectionA: (index, position = "start") => {
          return (
            controlRefA.current?.setSelectionInBlock?.(index, position) ?? false
          );
        },
        setSelectionB: (index, position = "start") => {
          return (
            controlRefB.current?.setSelectionInBlock?.(index, position) ?? false
          );
        },
        getBlocksA: () => controlRefA.current?.getBlocks?.() ?? [],
        getBlocksB: () => controlRefB.current?.getBlocks?.() ?? [],
        getSelectionA: () =>
          controlRefA.current?.getSelectionInBlock?.()?.selection ?? null,
        getSelectionB: () =>
          controlRefB.current?.getSelectionInBlock?.()?.selection ?? null,
      };
    }, []);

    const actions = {
      _syncstring: syncRef.current,
      set_value: (value: string) => {
        syncRef.current.set(value);
        setMarkdown(value);
      },
      syncstring_commit: () => undefined,
    };

    return (
      <HarnessErrorBoundary>
        <FrameContext.Provider value={defaultFrameContext}>
          <div
            style={{
              padding: 16,
              width: 640,
              height: 360,
              display: "flex",
              gap: 16,
            }}
          >
            <div style={{ width: 300 }} data-testid="collab-editor-a">
              <BlockMarkdownEditor
                value={markdown}
                actions={actions}
                minimal={true}
                height="320px"
                noVfill={true}
                hidePath={true}
                ignoreRemoteMergesWhileFocused={false}
                remoteMergeIdleMs={150}
                getValueRef={getValueRefA}
                controlRef={controlRefA}
              />
            </div>
            <div style={{ width: 300 }} data-testid="collab-editor-b">
              <BlockMarkdownEditor
                value={markdown}
                actions={actions}
                minimal={true}
                height="320px"
                noVfill={true}
                hidePath={true}
                ignoreRemoteMergesWhileFocused={false}
                remoteMergeIdleMs={150}
                getValueRef={getValueRefB}
                controlRef={controlRefB}
              />
            </div>
          </div>
        </FrameContext.Provider>
      </HarnessErrorBoundary>
    );
  }

  if (collabMode) {
    class FakeSyncstring {
      value: string;
      listeners: Set<() => void>;
      constructor(initial: string) {
        this.value = initial;
        this.listeners = new Set();
      }
      to_str() {
        return this.value;
      }
      set(value: string) {
        this.value = value;
        this.emit();
      }
      on(event: string, cb: () => void) {
        if (event === "change") {
          this.listeners.add(cb);
        }
      }
      removeListener(event: string, cb: () => void) {
        if (event === "change") {
          this.listeners.delete(cb);
        }
      }
      emit() {
        for (const cb of this.listeners) {
          cb();
        }
      }
    }

    const [markdown, setMarkdown] = useState<string>(
      "alpha\n\nbeta\n\ncharlie\n",
    );
    const syncRef = useRef(new FakeSyncstring(markdown));
    const getValueRefA = useRef<() => string>(() => "");
    const getValueRefB = useRef<() => string>(() => "");
    const controlRefA = useRef<any>(null);
    const controlRefB = useRef<any>(null);
    const selectionRefA = useRef<{
      setSelection: (range: Range) => void;
      getSelection: () => Range | null;
    } | null>(null);
    const selectionRefB = useRef<{
      setSelection: (range: Range) => void;
      getSelection: () => Range | null;
    } | null>(null);

    useEffect(() => {
      window.__slateCollabTest = {
        getMarkdownA: () => getValueRefA.current?.() ?? "",
        getMarkdownB: () => getValueRefB.current?.() ?? "",
        setRemote: (value) => {
          syncRef.current.set(value);
        },
        setSelectionA: (range) => {
          if (typeof range === "number") return false;
          selectionRefA.current?.setSelection(range);
          return true;
        },
        setSelectionB: (range) => {
          if (typeof range === "number") return false;
          selectionRefB.current?.setSelection(range);
          return true;
        },
        setSelectionFromMarkdownA: (pos) => {
          return (
            controlRefA.current?.setSelectionFromMarkdownPosition?.(pos) ??
            false
          );
        },
        setSelectionFromMarkdownB: (pos) => {
          return (
            controlRefB.current?.setSelectionFromMarkdownPosition?.(pos) ??
            false
          );
        },
        getSelectionA: () => selectionRefA.current?.getSelection() ?? null,
        getSelectionB: () => selectionRefB.current?.getSelection() ?? null,
      };
    }, []);

    const actions = {
      _syncstring: syncRef.current,
      set_value: (value: string) => {
        syncRef.current.set(value);
        setMarkdown(value);
      },
      syncstring_commit: () => undefined,
    };

    return (
      <HarnessErrorBoundary>
        <FrameContext.Provider value={defaultFrameContext}>
          <div
            style={{
              padding: 16,
              width: 640,
              height: 320,
              display: "flex",
              gap: 16,
            }}
          >
            <div style={{ width: 300 }} data-testid="collab-editor-a">
              <EditableMarkdown
                value={markdown}
                actions={actions}
                minimal={true}
                height="300px"
                noVfill={true}
                hidePath={true}
                disableWindowing={true}
                ignoreRemoteMergesWhileFocused={false}
                remoteMergeIdleMs={150}
                controlRef={controlRefA}
                selectionRef={selectionRefA}
                getValueRef={getValueRefA}
              />
            </div>
            <div style={{ width: 300 }} data-testid="collab-editor-b">
              <EditableMarkdown
                value={markdown}
                actions={actions}
                minimal={true}
                height="300px"
                noVfill={true}
                hidePath={true}
                disableWindowing={true}
                ignoreRemoteMergesWhileFocused={false}
                remoteMergeIdleMs={150}
                controlRef={controlRefB}
                selectionRef={selectionRefB}
                getValueRef={getValueRefB}
              />
            </div>
          </div>
        </FrameContext.Provider>
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
        if (autoformatMode) {
          // @ts-ignore - insertText supports autoformat flag.
          editor.insertText(" ", true);
        } else {
          Editor.insertText(editor, " ");
          inlineAutoformatAtCursor(editor);
        }
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
        const handled = handler({
          editor: editor as any,
          extra: { actions: {}, id: "", search: {} as any },
        });
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
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
                          const path = ReactEditor.findPath(
                            editor,
                            codeElement,
                          );
                          Transforms.removeNodes(editor, { at: path });
                          Transforms.insertNodes(editor, doc as any, {
                            at: path,
                          });
                        });
                      }}
                    >
                      Markdown
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
    if (typeof window !== "undefined") {
      (window as any).__slateHarnessError = {
        message: error?.message ?? String(error),
        stack: error?.stack ?? "",
      };
    }
    this.setState({ error });
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const message = this.state.error?.message ?? String(this.state.error);
      return <pre data-testid="harness-error">{message}</pre>;
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

  const replacement = codeMatch ? codeMatch[1] : (boldMatch?.[1] ?? "");
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
