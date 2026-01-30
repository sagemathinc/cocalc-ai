/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Component that allows WYSIWYG editing of markdown.

const EXPENSIVE_DEBUG = false;
// const EXPENSIVE_DEBUG = (window as any).cc != null && true; // EXTRA SLOW -- turn off before release!

import { delay } from "awaiting";
import { Map } from "immutable";
import { debounce, isEqual, throttle } from "lodash";
import {
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CSS, React, useIsMountedRef } from "@cocalc/frontend/app-framework";
import { SubmitMentionsRef } from "@cocalc/frontend/chat/types";
import { useMentionableUsers } from "@cocalc/frontend/editors/markdown-input/mentionable-users";
import { submit_mentions } from "@cocalc/frontend/editors/markdown-input/mentions";
import { EditorFunctions } from "@cocalc/frontend/editors/markdown-input/multimode";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { Path } from "@cocalc/frontend/frame-editors/frame-tree/path";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { EditorState } from "@cocalc/frontend/frame-editors/frame-tree/types";
import { markdown_to_html } from "@cocalc/frontend/markdown";
import Fragment, { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import {
  Descendant,
  DecoratedRange,
  Editor,
  Element as SlateElement,
  Node,
  Range,
  Text,
  Transforms,
  createEditor,
} from "slate";
import { resetSelection } from "./control";
import * as control from "./control";
import { SimpleInputMerge } from "@cocalc/sync/editor/generic/simple-input-merge";
import { useBroadcastCursors, useCursorDecorate } from "./cursors";
import { EditBar, useLinkURL, useListProperties, useMarks } from "./edit-bar";
import { Element } from "./element";
import { estimateSize } from "./elements";
import { createEmoji } from "./elements/emoji/index";
import { withInsertBreakHack } from "./elements/link/editable";
import { createMention } from "./elements/mention/editable";
import { Mention } from "./elements/mention/index";
import { withCodeLineInsertBreak } from "./elements/code-block/with-code-line-insert-break";
import { withAutoFormat } from "./format";
import { getHandler as getKeyboardHandler } from "./keyboard";
import Leaf from "./leaf-with-cursor";
import { markdown_to_slate } from "./markdown-to-slate";
import { withNormalize } from "./normalize";
import { applyOperations, preserveScrollPosition } from "./operations";
import { withNonfatalRange, withSelectionSafety } from "./patches";
import { stripBlankParagraphs } from "./padding";
import { withIsInline, withIsVoid } from "./plugins";
import { getScrollState, setScrollState } from "./scroll";
import { SearchHook, useSearch } from "./search";
import { slateDiff } from "./slate-diff";
import { useEmojis } from "./slate-emojis";
import { useMentions } from "./slate-mentions";
import { Editable, ReactEditor, Slate, withReact } from "./slate-react";
import type { RenderElementProps } from "./slate-react";
import { logSlateDebug } from "./slate-utils/slate-debug";
import { slate_to_markdown } from "./slate-to-markdown";
import { slatePointToMarkdownPosition } from "./sync";
import { ensureRange, pointAtPath } from "./slate-util";
import {
  applyBlockDiffPatch,
  diffBlockSignatures,
  remapSelectionAfterBlockPatch,
  shouldDeferBlockPatch,
} from "./sync/block-diff";
import type { SlateEditor } from "./types";
import { Actions } from "./types";
import useUpload from "./upload";
import { ChangeContext } from "./use-change";
import { buildCodeBlockDecorations, getPrismGrammar } from "./elements/code-block/prism";
import type { CodeBlock } from "./elements/code-block/types";
import BlockMarkdownEditor, {
  shouldUseBlockEditor,
} from "./block-markdown-editor";

export type { SlateEditor };

// Whether or not to use windowing by default (=only rendering visible elements).
// This is unfortunately essential.  I've tried everything I can think
// of to optimize slate without using windowing, and I just can't do it
// (and my attempts have always been misleading).  I think the problem is
// that all the subtle computations that are done when selection, etc.
// gets updated, just have to be done one way or another anyways. Doing
// them without the framework of windowing is probably much harder.
// NOTE: we also fully use slate without windowing in many context in which
// we're editing small snippets of Markdown, e.g., Jupyter notebook markdown
// cells, task lists, whiteboard sticky notes, etc.
const USE_WINDOWING = true;
// const USE_WINDOWING = false;

const STYLE: CSS = {
  width: "100%",
  overflow: "auto",
} as const;

function isBlockPatchEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const anyWindow = window as any;
  if (anyWindow.COCALC_SLATE_REMOTE_MERGE?.blockPatch) return true;
  if (anyWindow.__slateSyncFlags?.blockPatch) return true;
  return Boolean(anyWindow.__slateBlockPatch);
}

function isBlockPatchDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const anyWindow = window as any;
  if (anyWindow.COCALC_SLATE_REMOTE_MERGE?.blockPatchDebug) return true;
  if (anyWindow.__slateSyncFlags?.blockPatchDebug) return true;
  return Boolean(anyWindow.__slateBlockPatchDebug);
}

function applyBlockDiffPatchWithDebug(
  editor: SlateEditor,
  prev: Descendant[],
  next: Descendant[],
): { applied: boolean; chunks: ReturnType<typeof diffBlockSignatures> } {
  const chunks = diffBlockSignatures(prev, next);
  const { applied } = applyBlockDiffPatch(editor, prev, next, chunks);
  if (isBlockPatchDebugEnabled()) {
    logSlateDebug("block-patch", { chunks });
  }
  return { applied, chunks };
}

interface Props {
  value?: string;
  placeholder?: string;
  actions?: Actions;
  read_only?: boolean;
  font_size?: number;
  id?: string;
  reload_images?: boolean; // I think this is used only to trigger an update
  is_current?: boolean;
  is_fullscreen?: boolean;
  editor_state?: EditorState;
  cursors?: Map<string, any>;
  hidePath?: boolean;
  disableWindowing?: boolean;
  style?: CSS;
  pageStyle?: CSS;
  editBarStyle?: CSS;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  hideSearch?: boolean;
  saveDebounceMs?: number;
  remoteMergeIdleMs?: number;
  ignoreRemoteMergesWhileFocused?: boolean;
  noVfill?: boolean;
  divRef?: RefObject<HTMLDivElement>;
  selectionRef?: MutableRefObject<{
    setSelection: Function;
    getSelection: Function;
  } | null>;
  height?: string; // css style or if "auto", then editor will grow to size of content instead of scrolling.
  onCursorTop?: () => void;
  onCursorBottom?: () => void;
  isFocused?: boolean;
  registerEditor?: (editor: EditorFunctions) => void;
  unregisterEditor?: () => void;
  getValueRef?: MutableRefObject<() => string>; // see comment in src/packages/frontend/editors/markdown-input/multimode.tsx
  submitMentionsRef?: SubmitMentionsRef; // when called this will submit all mentions in the document, and also returns current value of the document (for compat with markdown editor).  If not set, mentions are submitted when you create them.  This prop is used mainly for implementing chat, which has a clear "time of submission".
  editBar2?: MutableRefObject<React.JSX.Element | undefined>;
  dirtyRef?: MutableRefObject<boolean>;
  minimal?: boolean;
  controlRef?: MutableRefObject<{
    moveCursorToEndOfLine: () => void;
    allowNextValueUpdateWhileFocused?: () => void;
  } | null>;
  showEditBar?: boolean;
  preserveBlankLines?: boolean;
  disableBlockEditor?: boolean;
}

const FullEditableMarkdown: React.FC<Props> = React.memo((props: Props) => {
  const {
    actions: actions0,
    autoFocus,
    cursors,
    dirtyRef,
    disableWindowing = !USE_WINDOWING,
    divRef,
    editBar2,
    editBarStyle,
    editor_state,
    font_size: font_size0,
    getValueRef,
    height,
    hidePath,
    hideSearch,
    id: id0,
    is_current,
    is_fullscreen,
    isFocused,
    minimal,
    noVfill,
    onBlur,
    onCursorBottom,
    onCursorTop,
    onFocus,
    pageStyle,
    placeholder,
    read_only,
    registerEditor,
    saveDebounceMs = SAVE_DEBOUNCE_MS,
    remoteMergeIdleMs,
    ignoreRemoteMergesWhileFocused = true,
    selectionRef,
    style,
    submitMentionsRef,
    unregisterEditor,
    value,
    controlRef,
    showEditBar,
    preserveBlankLines: preserveBlankLinesProp,
  } = props;
  const { project_id, path, desc, isVisible } = useFrameContext();
  const isMountedRef = useIsMountedRef();
  const id = id0 ?? "";
  const actions = actions0 ?? {};
  const font_size = font_size0 ?? desc?.get("font_size") ?? DEFAULT_FONT_SIZE; // so possible to use without specifying this.  TODO: should be from account settings
  const preserveBlankLines = preserveBlankLinesProp ?? false;
  const [change, setChange] = useState<number>(0);
  const mergeHelperRef = useRef<SimpleInputMerge>(
    new SimpleInputMerge(value ?? ""),
  );
  const remoteMergeConfig =
    typeof window === "undefined"
      ? {}
      : ((window as any).COCALC_SLATE_REMOTE_MERGE ?? {});
  const ignoreRemoteWhileFocused =
    remoteMergeConfig.ignoreWhileFocused ?? ignoreRemoteMergesWhileFocused;
  const mergeIdleMs =
    remoteMergeConfig.idleMs ?? remoteMergeIdleMs ?? saveDebounceMs ?? SAVE_DEBOUNCE_MS;

  // Defer remote merges while typing/composing to avoid cursor jumps.
  const lastLocalEditAtRef = useRef<number>(0);
  const pendingRemoteRef = useRef<string | null>(null);
  const pendingRemoteTimerRef = useRef<number | null>(null);
  const mergeIdleMsRef = useRef<number>(mergeIdleMs);
  mergeIdleMsRef.current = mergeIdleMs;
  const [pendingRemoteIndicator, setPendingRemoteIndicator] =
    useState<boolean>(false);
  const allowFocusedValueUpdateRef = useRef<boolean>(false);
  const blurMergeTimerRef = useRef<number | null>(null);

  const editor = useMemo(() => {
    const ed = withSelectionSafety(
      withNonfatalRange(
        withInsertBreakHack(
          withNormalize(
            withAutoFormat(
              withIsInline(
                withIsVoid(withCodeLineInsertBreak(withReact(createEditor()))),
              ),
            ),
          ),
        ),
      ),
    ) as SlateEditor;
    actions.registerSlateEditor?.(id, ed);

    ed.getSourceValue = (fragment?) => {
      return fragment
        ? slate_to_markdown(fragment, {
            preserveBlankLines: ed.preserveBlankLines,
          })
        : ed.getMarkdownValue();
    };

    // hasUnsavedChanges is true if the children changed
    // since last time resetHasUnsavedChanges() was called.
    ed._hasUnsavedChanges = false;
    ed.resetHasUnsavedChanges = () => {
      delete ed.markdownValue;
      ed._hasUnsavedChanges = ed.children;
    };
    ed.hasUnsavedChanges = () => {
      if (ed._hasUnsavedChanges === false) {
        // initially no unsaved changes
        return false;
      }
      return ed._hasUnsavedChanges !== ed.children;
    };

    ed.markdownValue = value;
    ed.getMarkdownValue = () => {
      if (ed.markdownValue != null && !ed.hasUnsavedChanges()) {
        return ed.markdownValue;
      }
      ed.markdownValue = slate_to_markdown(ed.children, {
        cache: ed.syncCache,
        preserveBlankLines: ed.preserveBlankLines,
      });
      return ed.markdownValue;
    };

    ed.selectionIsCollapsed = () => {
      return ed.selection == null || Range.isCollapsed(ed.selection);
    };

    if (getValueRef != null) {
      getValueRef.current = ed.getMarkdownValue;
    }

    ed.getPlainValue = (fragment?) => {
      const markdown = ed.getSourceValue(fragment);
      return $("<div>" + markdown_to_html(markdown) + "</div>").text();
    };

    ed.saveValue = (force?) => {
      if (!force && !editor.hasUnsavedChanges()) {
        return;
      }
      setSyncstringFromSlate();
      actions.ensure_syncstring_is_saved?.();
    };

    ed.syncCache = {};
    if ((ed as any).codeBlockExpandState == null) {
      (ed as any).codeBlockExpandState = new (globalThis as any).Map();
    }
    if (selectionRef != null) {
      selectionRef.current = {
        setSelection: (selection: any) => {
          if (!selection) return;
          const safe = ensureRange(editor, selection);
          // We confirm that the selection is valid.
          // If not, this will throw an error.
          const { anchor, focus } = safe;
          Editor.node(editor, anchor);
          Editor.node(editor, focus);
          logSlateDebug("selection-ref:set", {
            selection: safe,
            editorSelection: ed.selection ?? null,
          });
          ed.selection = safe;
        },
        getSelection: () => {
          return ed.selection;
        },
      };
    }

    if (controlRef != null) {
      controlRef.current = {
        ...(controlRef.current ?? {}),
        moveCursorToEndOfLine: () => control.moveCursorToEndOfLine(ed),
        allowNextValueUpdateWhileFocused: () => {
          allowFocusedValueUpdateRef.current = true;
        },
      };
    }

    ed.onCursorBottom = onCursorBottom;
    ed.onCursorTop = onCursorTop;
    ed.preserveBlankLines = preserveBlankLines;

    return ed as SlateEditor;
  }, []);

  useEffect(() => {
    editor.preserveBlankLines = preserveBlankLines;
  }, [editor, preserveBlankLines]);

  const isMergeFocused = useCallback(() => {
    return ReactEditor.isFocused(editor) || editor.getIgnoreSelection?.();
  }, [editor]);

  function shouldDeferRemoteMerge(): boolean {
    if (!isMergeFocused()) return false;
    if (ignoreRemoteWhileFocused) return true;
    const idleMs = mergeIdleMsRef.current;
    const recentlyTyped = Date.now() - lastLocalEditAtRef.current < idleMs;
    return !!editor.isComposing || recentlyTyped;
  }

  const updatePendingRemoteIndicator = useCallback(
    (remote: string, local: string) => {
    const preview = mergeHelperRef.current.previewMerge({ remote, local });
    if (!preview.changed) {
      pendingRemoteRef.current = null;
      mergeHelperRef.current.noteApplied(preview.merged);
    } else {
      pendingRemoteRef.current = remote;
    }
      setPendingRemoteIndicator((prev) =>
        prev === preview.changed ? prev : preview.changed,
      );
      return preview.changed;
    },
    [],
  );

  function schedulePendingRemoteMerge() {
    if (pendingRemoteTimerRef.current != null) {
      window.clearTimeout(pendingRemoteTimerRef.current);
    }
    const idleMs = mergeIdleMsRef.current;
    pendingRemoteTimerRef.current = window.setTimeout(() => {
      pendingRemoteTimerRef.current = null;
      flushPendingRemoteMerge();
    }, idleMs);
  }

  function flushPendingRemoteMerge(force = false) {
    const pending = pendingRemoteRef.current;
    if (pending == null) return;
    if (!force && shouldDeferRemoteMerge()) {
      schedulePendingRemoteMerge();
      return;
    }
    pendingRemoteRef.current = null;
    setPendingRemoteIndicator(false);
    mergeHelperRef.current.handleRemote({
      remote: pending,
      getLocal: () => editor.getMarkdownValue(),
      applyMerged: setEditorToValue,
    });
  }

  useEffect(() => {
    return () => {
      if (pendingRemoteTimerRef.current != null) {
        window.clearTimeout(pendingRemoteTimerRef.current);
      }
    };
  }, []);

  // hook up to syncstring if available:
  useEffect(() => {
    if (actions._syncstring == null) return;
    const change = () => {
      const remote = actions._syncstring?.to_str() ?? "";
      if (ignoreRemoteWhileFocused && isMergeFocused()) {
        updatePendingRemoteIndicator(remote, editor.getMarkdownValue());
        return;
      }
      if (shouldDeferRemoteMerge()) {
        pendingRemoteRef.current = remote;
        schedulePendingRemoteMerge();
        return;
      }
      mergeHelperRef.current.handleRemote({
        remote,
        getLocal: () => editor.getMarkdownValue(),
        applyMerged: setEditorToValue,
      });
    };
    actions._syncstring.on("change", change);
    return () => {
      if (actions._syncstring == null) {
        // This can be null if doc closed before unmounting.  I hit a crash because of this in production.
        return;
      }
      actions._syncstring.removeListener("change", change);
    };
  }, []);

  useEffect(() => {
    if (registerEditor != null) {
      registerEditor({
        set_cursor: ({ y }) => {
          // This is used for navigating in Jupyter.  Of course cursors
          // or NOT given by x,y positions in Slate, so we have to interpret
          // this as follows, since that's what is used by our Jupyter actions.
          //    y = 0: top of document
          //    y = -1: bottom of document
          if (y == 0) {
            // top of doc
            const focus = pointAtPath(editor, [], 0, "start");
            Transforms.setSelection(editor, {
              focus,
              anchor: focus,
            });
          } else if (y == -1) {
            // bottom of doc
            const focus = pointAtPath(editor, [], undefined, "end");
            Transforms.setSelection(editor, {
              focus,
              anchor: focus,
            });
          }
        },
        get_cursor: () => {
          const point = editor.selection?.anchor;
          if (point == null) {
            return { x: 0, y: 0 };
          }
          const pos = slatePointToMarkdownPosition(editor, point);
          if (pos == null) return { x: 0, y: 0 };
          const { line, ch } = pos;
          return { y: line, x: ch };
        },
      });

      return unregisterEditor;
    }
  }, [registerEditor, unregisterEditor]);

  useEffect(() => {
    if (isFocused == null) return;
    if (ReactEditor.isFocused(editor) != isFocused) {
      if (isFocused) {
        ReactEditor.focus(editor);
      } else {
        ReactEditor.blur(editor);
      }
    }
  }, [isFocused]);

  const [editorValue, setEditorValue] = useState<Descendant[]>(() => {
    const doc = markdown_to_slate(value ?? "", false, editor.syncCache);
    return preserveBlankLines ? doc : stripBlankParagraphs(doc);
  });
  const bumpChangeRef = useRef<() => void>(() => {});
  useEffect(() => {
    bumpChangeRef.current = () => {
      setEditorValue([...editor.children]);
      setChange((prev) => prev + 1);
    };
    (editor as any).__bumpChangeOnAutoformat = bumpChangeRef.current;
    return () => {
      if ((editor as any).__bumpChangeOnAutoformat === bumpChangeRef.current) {
        (editor as any).__bumpChangeOnAutoformat = undefined;
      }
    };
  }, [editor]);

  const rowSizeEstimator = useCallback((node) => {
    return estimateSize({ node, fontSize: font_size });
  }, []);

  const mentionableUsers = useMentionableUsers();

  const mentions = useMentions({
    isVisible,
    editor,
    insertMention: (editor, account_id) => {
      Transforms.insertNodes(editor, [
        createMention(account_id),
        { text: " " },
      ]);
      if (submitMentionsRef == null) {
        // submit immediately, since no ref for controlling this:
        submit_mentions(project_id, path, [{ account_id, description: "" }]);
      }
    },
    matchingUsers: (search) =>
      mentionableUsers(search, { avatarLLMSize: 20, avatarUserSize: 20 }),
  });

  const emojis = useEmojis({
    editor,
    insertEmoji: (editor, content, markup) => {
      Transforms.insertNodes(editor, [
        createEmoji(content, markup),
        { text: " " },
      ]);
    },
  });

  useEffect(() => {
    if (submitMentionsRef != null) {
      submitMentionsRef.current = (
        fragmentId?: FragmentId,
        onlyValue = false,
      ) => {
        if (project_id == null || path == null) {
          throw Error(
            "project_id and path must be set in order to use mentions.",
          );
        }

        if (!onlyValue) {
          const fragment_id = Fragment.encode(fragmentId);

          // No mentions in the document were already sent, so we send them now.
          // We have to find all mentions in the document tree, and submit them.
          const mentions: {
            account_id: string;
            description: string;
            fragment_id: string;
          }[] = [];
          for (const [node, path] of Editor.nodes(editor, {
            at: { path: [], offset: 0 },
            match: (node) => node["type"] == "mention",
          })) {
            const [parent] = Editor.parent(editor, path);
            mentions.push({
              account_id: (node as Mention).account_id,
              description: slate_to_markdown([parent], {
                preserveBlankLines: editor.preserveBlankLines,
              }),
              fragment_id,
            });
          }

          submit_mentions(project_id, path, mentions);
        }
        const value = editor.getMarkdownValue();
        return value;
      };
    }
  }, [submitMentionsRef]);

  const search: SearchHook = useSearch({ editor });

  const { marks, updateMarks } = useMarks(editor);

  const { linkURL, updateLinkURL } = useLinkURL(editor);

  const { listProperties, updateListProperties } = useListProperties(editor);

  const updateScrollState = useMemo(() => {
    const { save_editor_state } = actions;
    if (save_editor_state == null) return () => {};
    if (disableWindowing) {
      return throttle(() => {
        if (!isMountedRef.current || !didRestoreScrollRef.current) return;
        const scroll = scrollRef.current?.scrollTop;
        if (scroll != null) {
          save_editor_state(id, { scroll });
        }
      }, 250);
    } else {
      return throttle(() => {
        if (!isMountedRef.current || !didRestoreScrollRef.current) return;
        const scroll = getScrollState(editor);
        if (scroll != null) {
          save_editor_state(id, { scroll });
        }
      }, 250);
    }
  }, []);

  const broadcastCursors = useBroadcastCursors({
    editor,
    broadcastCursors: (x) => actions.set_cursor_locs?.(x),
  });

  const cursorDecorate = useCursorDecorate({
    editor,
    cursors,
    value: value ?? "",
    search,
  });

  const codeBlockCacheRef = useRef<
    WeakMap<
      SlateElement,
      { text: string; info: string; decorations: DecoratedRange[][] }
    >
  >(new WeakMap());

  const codeDecorate = useCallback(
    ([node, path]): DecoratedRange[] => {
      if (!Text.isText(node)) return [];
      const lineEntry = Editor.above(editor, {
        at: path,
        match: (n) => SlateElement.isElement(n) && n.type === "code_line",
      });
      if (!lineEntry) return [];
      const blockEntry = Editor.above(editor, {
        at: path,
        match: (n) =>
          SlateElement.isElement(n) &&
          (n.type === "code_block" ||
            n.type === "html_block" ||
            n.type === "meta"),
      });
      if (!blockEntry) return [];
      const [block, blockPath] = blockEntry as [SlateElement, number[]];
      const lineIndex = lineEntry[1][lineEntry[1].length - 1];
      const cache = codeBlockCacheRef.current;
      const text = block.children.map((line) => Node.string(line)).join("\n");
      const info =
        block.type === "code_block"
          ? (block as CodeBlock).info ?? ""
          : block.type === "html_block"
            ? "html"
            : "yaml";
      const cached = cache.get(block);
      if (!cached || cached.text !== text || cached.info !== info) {
        if (getPrismGrammar(info, text)) {
          cache.set(block, {
            text,
            info,
            decorations: buildCodeBlockDecorations(
              block as CodeBlock,
              blockPath,
              info,
            ),
          });
        } else {
          cache.set(block, { text, info, decorations: [] });
        }
      }
      return cache.get(block)?.decorations?.[lineIndex] ?? [];
    },
    [editor],
  );

  const decorate = useCallback(
    (entry) => {
      const ranges = cursorDecorate(entry);
      const extra = codeDecorate(entry);
      return extra.length ? ranges.concat(extra) : ranges;
    },
    [cursorDecorate, codeDecorate],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const didRestoreScrollRef = useRef<boolean>(false);
  const restoreScroll = useMemo(() => {
    return async () => {
      if (didRestoreScrollRef.current) return; // so we only ever do this once.
      try {
        const scroll = editor_state?.get("scroll");
        if (!scroll) return;

        if (!disableWindowing) {
          // Restore scroll for windowing
          try {
            await setScrollState(editor, scroll.toJS());
          } catch (err) {
            // could happen, e.g, if we change the format or change windowing.
            console.log(`restoring scroll state -- ${err}`);
          }
          return;
        }

        // Restore scroll for no windowing.
        // scroll = the scrollTop position, though we wrap in
        // exception since it could be anything.
        await new Promise(requestAnimationFrame);
        if (scrollRef.current == null || !isMountedRef.current) {
          return;
        }
        const elt = $(scrollRef.current);
        try {
          elt.scrollTop(scroll);
          // scrolling after image loads
          elt.find("img").on("load", () => {
            if (!isMountedRef.current) return;
            elt.scrollTop(scroll);
          });
        } catch (_) {}
      } finally {
        didRestoreScrollRef.current = true;
        setOpacity(undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (actions._syncstring == null) {
      const allowFocusedValueUpdate = allowFocusedValueUpdateRef.current;
      if (
        ignoreRemoteWhileFocused &&
        isMergeFocused() &&
        value != null &&
        value !== editor.getMarkdownValue() &&
        !allowFocusedValueUpdate
      ) {
        updatePendingRemoteIndicator(value, editor.getMarkdownValue());
        return;
      }
      allowFocusedValueUpdateRef.current = false;
      setEditorToValue(value);
    }
    if (value != "Loading...") {
      restoreScroll();
    }
  }, [value, ignoreRemoteWhileFocused, updatePendingRemoteIndicator, isMergeFocused]);

  const lastSetValueRef = useRef<string | null>(null);

  const setSyncstringFromSlateNOW = () => {
    if (actions.set_value == null) {
      // no way to save the value out (e.g., just beginning to test
      // using the component).
      return;
    }
    if (!editor.hasUnsavedChanges()) {
      // there are no changes to save
      return;
    }

    const markdown = editor.getMarkdownValue();
    lastSetValueRef.current = markdown;
    mergeHelperRef.current.noteSaved(markdown);
    actions.set_value(markdown);
    actions.syncstring_commit?.();

    // Record that the syncstring's value is now equal to ours:
    editor.resetHasUnsavedChanges();
  };

  const setSyncstringFromSlate = useMemo(() => {
    if (saveDebounceMs) {
      return debounce(setSyncstringFromSlateNOW, saveDebounceMs);
    } else {
      // this case shouldn't happen
      return setSyncstringFromSlateNOW;
    }
  }, []);

  // We don't want to do saveValue too much, since it presumably can be slow,
  // especially if the document is large. By debouncing, we only do this when
  // the user pauses typing for a moment. Also, this avoids making too many commits.
  // For tiny documents, user can make this small or even 0 to not debounce.
  const saveValueDebounce =
    saveDebounceMs != null && !saveDebounceMs
      ? () => editor.saveValue()
      : useMemo(
          () =>
            debounce(
              () => editor.saveValue(),
              saveDebounceMs ?? SAVE_DEBOUNCE_MS,
            ),
          [],
        );

  function onKeyDown(e) {
    if (read_only) {
      e.preventDefault();
      return;
    }

    mentions.onKeyDown(e);
    emojis.onKeyDown(e);

    if (e.defaultPrevented) return;

    if (!ReactEditor.isFocused(editor)) {
      // E.g., when typing into a codemirror editor embedded
      // in slate, we get the keystrokes, but at the same time
      // the (contenteditable) editor itself is not focused.
      return;
    }

    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === "a" || e.key === "A")
    ) {
      logSlateDebug("key:select-all", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        repeat: e.repeat,
        isComposing: e.isComposing,
        selection: editor.selection ?? null,
      });
    }

    const handler = getKeyboardHandler(e);
    if (handler != null) {
      const extra = { actions, id, search };
      if (handler({ editor, extra })) {
        e.preventDefault();
        // key was handled.
        return;
      }
    }
  }

  useEffect(() => {
    if (!is_current) {
      if (editor.hasUnsavedChanges()) {
        // just switched from focused to not and there was
        // an unsaved change, so save state.
        setSyncstringFromSlate();
        actions.ensure_syncstring_is_saved?.();
      }
    }
  }, [is_current]);

  const setEditorToValue = (value) => {
    // console.log("setEditorToValue", { value, ed: editor.getMarkdownValue() });
    if (lastSetValueRef.current == value) {
      // this always happens once right after calling setSyncstringFromSlateNOW
      // and it can randomly undo the last thing done, so don't do that!
      // Also, this is an excellent optimization to do as well.
      lastSetValueRef.current = null;
      // console.log("setEditorToValue: skip");
      return;
    }
    if (value == null) return;
    const previousEditorValue = editor.children;

    // we only use the latest version of the document
    // for caching purposes.
    editor.syncCache = {};
    // There is an assumption here that markdown_to_slate produces
    // a document that is properly normalized.  If that isn't the
    // case, things will go horribly wrong, since it'll be impossible
    // to convert the document to equal nextEditorValue.  In the current
    // code we do nomalize the output of markdown_to_slate, so
    // that assumption is definitely satisfied.
    const nextEditorValueRaw = markdown_to_slate(
      value,
      false,
      editor.syncCache,
    );
    const nextEditorValue = preserveBlankLines
      ? nextEditorValueRaw
      : stripBlankParagraphs(nextEditorValueRaw);
    const normalizedValue = preserveBlankLines
      ? value
      : slate_to_markdown(nextEditorValue, {
          cache: editor.syncCache,
          preserveBlankLines,
        });

    if (lastSetValueRef.current == normalizedValue) {
      lastSetValueRef.current = null;
      return;
    }
    if (normalizedValue == editor.getMarkdownValue()) {
      // nothing to do, and in fact doing something
      // could be really annoying, since we don't want to
      // autoformat via markdown everything immediately,
      // as ambiguity is resolved while typing...
      return;
    }

    const blockPatchEnabled = isBlockPatchEnabled() && isMergeFocused();
    const activeBlockIndex = editor.selection?.anchor?.path?.[0];
    const recentlyTyped =
      Date.now() - lastLocalEditAtRef.current < mergeIdleMsRef.current;
    const shouldDirectSet =
      previousEditorValue.length <= 1 &&
      nextEditorValue.length >= 40 &&
      !ReactEditor.isFocused(editor);
    let operations: ReturnType<typeof slateDiff> | null = null;
    if (!blockPatchEnabled) {
      operations = shouldDirectSet
        ? []
        : slateDiff(previousEditorValue, nextEditorValue);
    }

    if (blockPatchEnabled) {
      const chunks = diffBlockSignatures(previousEditorValue, nextEditorValue);
      const defer = shouldDeferBlockPatch(chunks, activeBlockIndex, recentlyTyped);
      if (defer) {
        pendingRemoteRef.current = value;
        schedulePendingRemoteMerge();
        if (isBlockPatchDebugEnabled()) {
          logSlateDebug("block-patch:defer-active", {
            activeBlockIndex,
            chunks,
          });
        }
        return;
      }
    }

    if (
      !shouldDirectSet &&
      !blockPatchEnabled &&
      operations != null &&
      operations.length == 0
    ) {
      // No ops needed, but still update markdown bookkeeping.
      editor.resetHasUnsavedChanges();
      editor.markdownValue = value;
      return;
    }

    Editor.withoutNormalizing(editor, () => {
      try {
        if (!ReactEditor.isUsingWindowing(editor)) {
          const operationsLength = operations?.length ?? 0;
          logSlateDebug("external-set-editor", {
            strategy: shouldDirectSet ? "direct" : "diff",
            operations: operationsLength,
            focused: isMergeFocused(),
            current: editor.getMarkdownValue(),
            next: normalizedValue,
          });
        }
        //const t = new Date();

        let blockPatchApplied = false;
        const previousSelection = editor.selection
          ? {
              anchor: { ...editor.selection.anchor },
              focus: { ...editor.selection.focus },
            }
          : null;
        if (blockPatchEnabled && !shouldDirectSet) {
          editor.syncCausedUpdate = true;
          const blockPatchResult = applyBlockDiffPatchWithDebug(
            editor,
            previousEditorValue,
            nextEditorValue,
          );
          blockPatchApplied = blockPatchResult.applied;
          if (blockPatchApplied && previousSelection) {
            const remapped = remapSelectionAfterBlockPatch(
              editor,
              previousSelection,
              blockPatchResult.chunks,
            );
            if (remapped) {
              editor.selection = remapped;
            }
          }
        }
        if (shouldDirectSet) {
          // This is a **MASSIVE** optimization.  E.g., for a few thousand
          // lines markdown file with about 500 top level elements (and lots
          // of nested lists), applying operations below starting with the
          // empty document can take 5-10 seconds, whereas just setting the
          // value is instant.  The drawback to directly setting the value
          // is only that it messes up selection, and it's difficult
          // to know where to move the selection to after changing.
          // However, if the editor isn't focused, we don't have to worry
          // about selection at all.  TODO: we might be able to avoid the
          // slateDiff stuff entirely via some tricky stuff, e.g., managing
          // the cursor on the plain text side before/after the change, since
          // codemirror is much faster att "setValueNoJump".
          // The main time we use this optimization here is when opening the
          // document in the first place, in which case we're converting
          // the document from "Loading..." to it's initial value.
          // Also, the default config is source text focused on the left and
          // editable text acting as a preview on the right not focused, and
          // again this makes things fastest.
          // DRAWBACK: this doesn't preserve scroll position and breaks selection.
          editor.syncCausedUpdate = true;
          // we call "onChange" instead of setEditorValue, since
          // we want all the change handler stuff to happen, e.g.,
          // broadcasting cursors.
          onChange(nextEditorValue);
          // console.log("time to set directly ", new Date() - t);
        } else if (!blockPatchApplied) {
          // Applying this operation below will trigger
          // an onChange, which it is best to ignore to save time and
          // also so we don't update the source editor (and other browsers)
          // with a view with things like loan $'s escaped.'
          editor.syncCausedUpdate = true;
          // console.log("setEditorToValue: applying operations...", { operations });
          if (operations == null) {
            operations = slateDiff(previousEditorValue, nextEditorValue);
          }
          preserveScrollPosition(editor, operations);
          applyOperations(editor, operations);
          // console.log("time to set via diff", new Date() - t);
        }
      } finally {
        // In all cases, now that we have transformed editor into the new value
        // let's save the fact that we haven't changed anything yet and we
        // know the markdown state with zero changes.  This is important, so
        // we don't save out a change if we don't explicitly make one.
        editor.resetHasUnsavedChanges();
        editor.markdownValue = normalizedValue;
      }

      try {
        if (editor.selection != null) {
          editor.selection = ensureRange(editor, editor.selection);
          // console.log("setEditorToValue: restore selection", editor.selection);
          const { anchor, focus } = editor.selection;
          Editor.node(editor, anchor);
          Editor.node(editor, focus);
        }
      } catch (err) {
        // TODO!
        console.warn(
          "slate - invalid selection after upstream patch. Resetting selection.",
          err,
        );
        // set to beginning of document -- better than crashing.
        resetSelection(editor);
      }

      //       if ((window as any).cc?.slate != null) {
      //         (window as any).cc.slate.eval = (s) => console.log(eval(s));
      //       }

      if (EXPENSIVE_DEBUG) {
        const stringify = require("json-stable-stringify");
        // We use JSON rather than isEqual here, since {foo:undefined}
        // is not equal to {}, but they JSON the same, and this is
        // fine for our purposes.
        if (stringify(editor.children) != stringify(nextEditorValue)) {
          // NOTE -- this does not 100% mean things are wrong.  One case where
          // this is expected behavior is if you put the cursor at the end of the
          // document, say right after a horizontal rule,  and then edit at the
          // beginning of the document in another browser.  The discrepancy
          // is because a "fake paragraph" is placed at the end of the browser
          // so your cursor has somewhere to go while you wait and type; however,
          // that space is not really part of the markdown document, and it goes
          // away when you move your cursor out of that space.
          console.warn(
            "**WARNING:  slateDiff might not have properly transformed editor, though this may be fine. See window.diffBug **",
          );
          (window as any).diffBug = {
            previousEditorValue,
            nextEditorValue,
            editorValue: editor.children,
            stringify,
            slateDiff,
            applyOperations,
            markdown_to_slate,
            value,
          };
        }
      }
    });
  };

  if ((window as any).cc != null) {
    // This only gets set when running in cc-in-cc dev mode -- i.e., it is for low level
    // interactive debugging and dev work.
    const { Editor, Node, Path, Range, Text } = require("slate");
    (window as any).cc.slate = {
      slateDiff,
      editor,
      actions,
      editor_state,
      Transforms,
      ReactEditor,
      Node,
      Path,
      Editor,
      Range,
      Text,
      scrollRef,
      applyOperations,
      markdown_to_slate,
      robot: async (s: string, iterations = 1) => {
        /*
        This little "robot" function is so you can run rtc on several browsers at once,
        with each typing random stuff at random, and checking that their input worked
        without loss of data.
        */
        let inserted = "";
        let focus = editor.selection?.focus;
        if (focus == null) throw Error("must have selection");
        let lastOffset = focus.offset;
        for (let n = 0; n < iterations; n++) {
          for (const x of s) {
            //               Transforms.setSelection(editor, {
            //                 focus,
            //                 anchor: focus,
            //               });
            editor.insertText(x);
            focus = editor.selection?.focus;
            if (focus == null) throw Error("must have selection");
            inserted += x;
            const offset = focus.offset;
            console.log(
              `${
                n + 1
              }/${iterations}: inserted '${inserted}'; focus="${JSON.stringify(
                editor.selection?.focus,
              )}"`,
            );
            if (offset != (lastOffset ?? 0) + 1) {
              console.error("SYNC FAIL!!", { offset, lastOffset });
              return;
            }
            lastOffset = offset;
            await delay(100 * Math.random());
            if (Math.random() < 0.2) {
              await delay(2 * SAVE_DEBOUNCE_MS);
            }
          }
        }
        console.log("SUCCESS!");
      },
    };
  }

  editor.inverseSearch = async function inverseSearch(
    force?: boolean,
  ): Promise<void> {
    if (
      !force &&
      (is_fullscreen || !actions.get_matching_frame?.({ type: "cm" }))
    ) {
      // - if user is fullscreen assume they just want to WYSIWYG edit
      // and double click is to select.  They can use sync button to
      // force opening source panel.
      // - if no source view, also don't do anything.  We only let
      // double click do something when there is an open source view,
      // since double click is used for selecting.
      return;
    }
    // delay to give double click a chance to change current focus.
    // This takes surprisingly long!
    let t = 0;
    while (editor.selection == null) {
      await delay(1);
      t += 50;
      if (t > 2000) return; // give up
    }
    const point = editor.selection?.anchor; // using anchor since double click selects word.
    if (point == null) {
      return;
    }
    const pos = slatePointToMarkdownPosition(editor, point);
    if (pos == null) return;
    actions.programmatical_goto_line?.(
      pos.line + 1, // 1 based (TODO: could use codemirror option)
      true,
      false, // it is REALLY annoying to switch focus to be honest, e.g., because double click to select a word is common in WYSIWYG editing.  If change this to true, make sure to put an extra always 50ms delay above due to focus even order.
      undefined,
      pos.ch,
    );
  };

  // WARNING: onChange does not fire immediately after changes occur.
  // It is fired by react and happens in some potentialy later render
  // loop after changes.  Thus you absolutely can't depend on it in any
  // way for checking if the state of the editor has changed.  Instead
  // check editor.children itself explicitly.
  const onChange = (newEditorValue) => {
    if (dirtyRef != null) {
      // but see comment above
      dirtyRef.current = true;
    }
    if (editor._hasUnsavedChanges === false) {
      // just for initial change.
      editor._hasUnsavedChanges = undefined;
    }
    if (!isMountedRef.current) return;
    broadcastCursors();
    updateMarks();
    updateLinkURL();
    updateListProperties();
    // Track where the last editor selection was,
    // since this is very useful to know, e.g., for
    // understanding cursor movement, format fallback, etc.
    // @ts-ignore
    if (editor.selection != null) {
      const safeSelection = ensureRange(editor, editor.selection);
      if (editor.lastSelection == null) {
        // initialize
        // @ts-ignore
        editor.lastSelection = editor.curSelection = safeSelection;
      }
      // @ts-ignore
      if (!isEqual(safeSelection, editor.curSelection)) {
        // @ts-ignore
        editor.lastSelection = editor.curSelection;
        // @ts-ignore
        editor.curSelection = safeSelection;
      }
    }
    if (editor.curSelection != null) {
      // @ts-ignore
      editor.curSelection = ensureRange(editor, editor.curSelection);
    }
    if (editor.lastSelection != null) {
      // @ts-ignore
      editor.lastSelection = ensureRange(editor, editor.lastSelection);
    }

    if (editorValue === newEditorValue) {
      // Editor didn't actually change value so nothing to do.
      return;
    }

    if (!editor.syncCausedUpdate) {
      lastLocalEditAtRef.current = Date.now();
    }

    setEditorValue(newEditorValue);
    setChange(change + 1);

    if (
      ignoreRemoteWhileFocused &&
      pendingRemoteRef.current != null &&
      ReactEditor.isFocused(editor)
    ) {
      updatePendingRemoteIndicator(
        pendingRemoteRef.current,
        editor.getMarkdownValue(),
      );
    }

    // Update mentions state whenever editor actually changes.
    // This may pop up the mentions selector.
    mentions.onChange();
    // Similar for emojis.
    emojis.onChange();

    if (!is_current) {
      // Do not save when editor not current since user could be typing
      // into another editor of the same underlying document.   This will
      // cause bugs (e.g., type, switch from slate to codemirror, type, and
      // see what you typed into codemirror disappear). E.g., this
      // happens due to a spurious change when the editor is defocused.

      return;
    }
    saveValueDebounce();
  };

  // Autoformat focus/selection recovery is handled in the insertText hook.

  useEffect(() => {
    editor.syncCausedUpdate = false;
  }, [editorValue]);

  const [opacity, setOpacity] = useState<number | undefined>(0);

  if (editBar2 != null) {
    editBar2.current = (
      <EditBar
        Search={search.Search}
        isCurrent={is_current}
        marks={marks}
        linkURL={linkURL}
        listProperties={listProperties}
        editor={editor}
        style={{ ...editBarStyle, paddingRight: 0 }}
        hideSearch={hideSearch}
      />
    );
  }

  const renderElement = useCallback(
    (props: RenderElementProps): React.JSX.Element => <Element {...props} />,
    [],
  );

  const useWindowing = !disableWindowing && ReactEditor.isUsingWindowing(editor);
  const showPendingRemoteIndicator =
    ignoreRemoteWhileFocused && pendingRemoteIndicator;

  const handleMergePending = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      flushPendingRemoteMerge(true);
    },
    [flushPendingRemoteMerge],
  );

  let slate = (
    <Slate editor={editor} value={editorValue} onChange={onChange}>
      <div style={{ position: "relative" }}>
        {showPendingRemoteIndicator && (
          <div
            role="button"
            tabIndex={0}
            onMouseDown={handleMergePending}
            onClick={handleMergePending}
            style={{
              position: "absolute",
              top: 6,
              right: 8,
              fontSize: 12,
              padding: "2px 8px",
              background: "rgba(255, 251, 230, 0.95)",
              border: "1px solid rgba(255, 229, 143, 0.9)",
              borderRadius: 4,
              color: "#8c6d1f",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            Remote changes pending
          </div>
        )}
        <Editable
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={
            useWindowing && height != "auto" ? "smc-vfill" : undefined
          }
          readOnly={read_only}
          renderElement={renderElement}
          renderLeaf={Leaf}
          onKeyDown={onKeyDown}
          onBlur={() => {
            editor.saveValue();
            updateMarks();
            if (ignoreRemoteWhileFocused) {
              if (blurMergeTimerRef.current != null) {
                window.clearTimeout(blurMergeTimerRef.current);
              }
              blurMergeTimerRef.current = window.setTimeout(() => {
                blurMergeTimerRef.current = null;
                if (!isMergeFocused()) {
                  flushPendingRemoteMerge();
                }
              }, 150);
            }
            onBlur?.();
          }}
          onFocus={() => {
            updateMarks();
            if (blurMergeTimerRef.current != null) {
              window.clearTimeout(blurMergeTimerRef.current);
              blurMergeTimerRef.current = null;
            }
            onFocus?.();
          }}
          decorate={decorate}
          divref={scrollRef}
          onScroll={() => {
            updateScrollState();
          }}
          style={
            useWindowing
              ? undefined
              : {
                  height,
                  position: "relative", // CRITICAL!!! Without this, editor will sometimes scroll the entire frame off the screen.  Do NOT delete position:'relative'.  5+ hours of work to figure this out!  Note that this isn't needed when using windowing above.
                  minWidth: "80%",
                  padding: "15px",
                  background: "white",
                  overflowX: "hidden",
                  overflowY:
                    height == "auto"
                      ? "hidden" /* for height='auto' we never want a scrollbar  */
                      : "auto" /* for this overflow, see https://github.com/ianstormtaylor/slate/issues/3706 */,
                  ...pageStyle,
                }
          }
          windowing={
            useWindowing
              ? {
                  rowStyle: {
                    // WARNING: do *not* use margin in rowStyle.
                    padding: minimal ? 0 : "0 70px",
                    overflow: "hidden", // CRITICAL: this makes it so the div height accounts for margin of contents (e.g., p element has margin), so virtuoso can measure it correctly.  Otherwise, things jump around like crazy.
                    minHeight: "1px", // virtuoso can't deal with 0-height items
                  },
                  marginTop: "40px",
                  marginBottom: "40px",
                  rowSizeEstimator,
                }
              : undefined
          }
        />
      </div>
    </Slate>
  );
  let body = (
    <ChangeContext.Provider value={{ change, editor }}>
      <div
        ref={divRef}
        className={noVfill || height === "auto" ? undefined : "smc-vfill"}
        style={{
          overflow: noVfill || height === "auto" ? undefined : "auto",
          backgroundColor: "white",
          ...style,
          height,
          minHeight: height == "auto" ? "50px" : undefined,
        }}
      >
        {!hidePath && (
          <Path is_current={is_current} path={path} project_id={project_id} />
        )}
        {showEditBar && (
          <EditBar
            Search={search.Search}
            isCurrent={is_current}
            marks={marks}
            linkURL={linkURL}
            listProperties={listProperties}
            editor={editor}
            style={editBarStyle}
            hideSearch={hideSearch}
          />
        )}
        <div
          className={noVfill || height == "auto" ? undefined : "smc-vfill"}
          style={{
            ...STYLE,
            fontSize: font_size,
            height,
            opacity,
          }}
        >
          {mentions.Mentions}
          {emojis.Emojis}
          {slate}
        </div>
      </div>
    </ChangeContext.Provider>
  );
  return useUpload(editor, body);
});

export const EditableMarkdown: React.FC<Props> = React.memo((props: Props) => {
  if (props.disableBlockEditor) {
    return <FullEditableMarkdown {...props} />;
  }
  if (
    shouldUseBlockEditor({
      value: props.value,
      height: props.height,
    })
  ) {
    return <BlockMarkdownEditor {...props} />;
  }
  return <FullEditableMarkdown {...props} />;
});
