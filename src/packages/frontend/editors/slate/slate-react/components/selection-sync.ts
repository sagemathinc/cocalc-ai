/*
Syncing the selection between slate and the DOM.

This started by factoring out the relevant code from editable.tsx.
We then rewrote it to work with windowing, which of course discards
the DOM outside the visible window, hence full sync no longer makes
sense -- instead the slate selection is the sole source of truth, and
the DOM just partly reflects that, and user manipulation of the DOM
merely influences slate's state, rather than completely determining it.

I spent forever (!) trying various strategies involving locks and
timeouts, which could never work perfectly on many different
platforms. This simple algorithm evidently does, and involves *NO*
asynchronous code or locks at all!  Also, there are no platform
specific hacks at all.
*/

import { useCallback, useRef } from "react";
import { useIsomorphicLayoutEffect } from "../hooks/use-isomorphic-layout-effect";
import { ReactEditor } from "..";
import { EDITOR_TO_ELEMENT } from "../utils/weak-maps";
import { Editor, Path, Point, Range, Selection, Transforms } from "slate";
import { hasEditableTarget, isTargetInsideVoid } from "./dom-utils";
import { DOMElement, DOMSelection } from "../utils/dom";
import { isEqual } from "lodash";
import {
  describeDomNode,
  describeDomSelection,
  logSlateDebug,
  withSelectionReason,
} from "../utils/slate-debug";

interface SelectionState {
  isComposing: boolean;
  shiftKey: boolean;
  latestElement: DOMElement | null;
  lastUserInputAt: number;
  lastPointerDownAt: number;
  lastSelectionKeyAt: number;

  // If part of the selection gets scrolled out of the DOM, we set windowedSelection
  // to true. The next time the selection in the DOM is read, we then set
  // windowedSelection to that read value and don't update editor.selection
  // unless the selection in the DOM is changed to something else manually.
  // This way editor.selection doesn't change at all (unless user actually manually
  // changes it), and true selection is then used to select proper part of editor
  // that is actually rendered in the DOM.
  windowedSelection?: true | Range;

  // if true, the selection sync hooks are temporarily disabled.
  ignoreSelection: boolean;

  // true when we are programmatically updating the DOM selection.
  updatingSelection: boolean;
  pendingSelectionReset: boolean;
}

const LOG_SELECTION_MISMATCHES =
  typeof process !== "undefined" &&
  process.env?.COCALC_SLATE_LOG_SELECTION === "1";
// Avoid stale DOM selection overwriting Slate selection during rapid typing.
const TYPING_SELECTION_SUPPRESS_MS = 500;
const POINTER_SELECTION_GRACE_MS = 500;
const SELECTION_KEY_GRACE_MS = 500;
const SELECTION_SYNC_SUPPRESS_MS = 250;

export const useUpdateDOMSelection = ({
  editor,
  state,
}: {
  editor: ReactEditor;
  state: SelectionState;
}) => {
  const lastSelectionRef = useRef<Selection | null | undefined>(undefined);
  const lastDomSelectionRef = useRef<DomSelectionSnapshot | null>(null);

  // Ensure that the DOM selection state is set to the editor selection.
  // Note that whenever the DOM gets updated (e.g., with every keystroke when editing)
  // the DOM selection gets completely reset (because react replaces the selected text
  // by new text), so this setting of the selection usually happens, and happens
  // **a lot**.
  const updateDOMSelection = () => {
    if (
      state.isComposing ||
      !ReactEditor.isFocused(editor) ||
      state.ignoreSelection
    ) {
      logSlateDebug("update-dom-selection:skip", {
        reason: "state",
        selection: editor.selection ?? null,
        editorSelection: editor.selection ?? null,
        state: debugState(state, editor),
      });
      return;
    }

    const domSelection = window.getSelection();
    if (!domSelection) {
      logSlateDebug("update-dom-selection:skip", {
        reason: "no-dom-selection",
        selection: editor.selection ?? null,
        editorSelection: editor.selection ?? null,
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      delete state.windowedSelection;
      return;
    }

    let selection;
    const editorSelection = editor.selection ?? null;
    try {
      selection = getWindowedSelection(editor);
    } catch (err) {
      // in rare cases when document / selection seriously "messed up", this
      // can happen because Editor.before throws below.  In such cases we
      // leave selection unchanged to avoid a spurious jump.
      console.warn(
        `getWindowedSelection warning - ${err} - leaving selection unchanged`,
      );
      logSlateDebug("update-dom-selection:skip", {
        reason: "get-windowed-selection-error",
        selection: editor.selection ?? null,
        editorSelection,
        state: debugState(state, editor),
      });
      return;
    }
    const isCropped = !isEqual(editor.selection, selection);
    if (!isEqual(editorSelection, selection)) {
      logSlateDebug("update-dom-selection:clipped", {
        selection: selection ?? null,
        editorSelection,
        activeElement: describeDomNode(window.document.activeElement),
        visibleRange: editor.windowedListRef?.current?.visibleRange ?? null,
        windowed: editor.windowedListRef?.current != null,
        state: debugState(state, editor),
      });
    }
    if (!isCropped) {
      delete state.windowedSelection;
    }
    //     console.log(
    //       "\nwindowed selection =",
    //       JSON.stringify(selection),
    //       "\neditor.selection   =",
    //       JSON.stringify(editor.selection)
    //     );
    const domSnapshot = getDomSelectionSnapshot(domSelection);
    if (
      isEqual(lastSelectionRef.current, selection) &&
      domSelectionMatchesSnapshot(domSnapshot, lastDomSelectionRef.current)
    ) {
      return;
    }

    const hasDomSelection = domSelection.type !== "None";

    // If the DOM selection is properly unset, we're done.
    if (!selection && !hasDomSelection) {
      logSlateDebug("update-dom-selection:noop", {
        selection: selection ?? null,
        editorSelection,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      recordSelectionState(
        selection,
        domSelection,
        lastSelectionRef,
        lastDomSelectionRef,
      );
      return;
    }

    // verify that the DOM selection is in the editor
    const editorElement = EDITOR_TO_ELEMENT.get(editor);
    const hasDomSelectionInEditor =
      editorElement?.contains(domSelection.anchorNode) &&
      editorElement?.contains(domSelection.focusNode);

    if (!selection) {
      // need to clear selection:
      if (hasDomSelectionInEditor) {
        // the current nontrivial selection is inside the editor,
        // so we just clear it.
        domSelection.removeAllRanges();
        if (isCropped) {
          state.windowedSelection = true;
        }
      }
      logSlateDebug("update-dom-selection:clear", {
        selection: selection ?? null,
        editorSelection,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
        isCropped,
      });
      recordSelectionState(
        selection,
        domSelection,
        lastSelectionRef,
        lastDomSelectionRef,
      );
      return;
    }
    let newDomRange;
    try {
      newDomRange = ReactEditor.toDOMRange(editor, selection);
    } catch (_err) {
      //       console.warn(
      //         `slate -- toDOMRange error ${_err}, range=${JSON.stringify(selection)}`
      //       );
      // This error happens and is expected! e.g., if you set the selection to a
      // point that isn't valid in the document.  TODO: Our
      // autoformat code perhaps stupidly does this sometimes,
      // at least when working on it.
      // It's better to just give up in this case, rather than
      // crash the entire cocalc.  The user will click somewhere
      // and be good to go again.
      return;
    }

    // Flip orientation of newDomRange if selection is backward,
    // since setBaseAndExtent (which we use below) is not oriented.
    if (Range.isBackward(selection)) {
      newDomRange = {
        endContainer: newDomRange.startContainer,
        endOffset: newDomRange.startOffset,
        startContainer: newDomRange.endContainer,
        startOffset: newDomRange.endOffset,
      };
    }

    // Compare the new DOM range we want to what's actually
    // selected.  If they are the same, done.  If different,
    // we change the selection in the DOM.
    if (
      domSelection.anchorNode?.isSameNode(newDomRange.startContainer) &&
      domSelection.focusNode?.isSameNode(newDomRange.endContainer) &&
      domSelection.anchorOffset === newDomRange.startOffset &&
      domSelection.focusOffset === newDomRange.endOffset
    ) {
      // It's correct already -- we're done.
      // console.log("useUpdateDOMSelection: selection already correct");
      recordSelectionState(
        selection,
        domSelection,
        lastSelectionRef,
        lastDomSelectionRef,
      );
      return;
    }

    // Finally, make the change:
    if (isCropped) {
      // record that we're making a change that diverges from true selection.
      state.windowedSelection = true;
    }
    logSlateDebug("update-dom-selection:set", {
      selection: selection ?? null,
      editorSelection,
      domSelection: describeDomSelection(domSelection),
      activeElement: describeDomNode(window.document.activeElement),
      state: debugState(state, editor),
      isCropped,
    });
    state.updatingSelection = true;
    try {
      domSelection.setBaseAndExtent(
        newDomRange.startContainer,
        newDomRange.startOffset,
        newDomRange.endContainer,
        newDomRange.endOffset,
      );
    } finally {
      recordSelectionState(
        selection,
        domSelection,
        lastSelectionRef,
        lastDomSelectionRef,
      );
      scheduleSelectionReset(state);
    }
  };

  // Always ensure DOM selection gets set to slate selection
  // right after the editor updates.  This is especially important
  // because the react update sets parts of the contenteditable
  // area, and can easily mess up or reset the cursor, so we have
  // to immediately set it back.
  useIsomorphicLayoutEffect(updateDOMSelection);

  // We also attach this function to the editor,
  // so can be called on scroll, which is needed to support windowing.
  editor.updateDOMSelection = updateDOMSelection;
};

export const useDOMSelectionChange = ({
  editor,
  state,
  readOnly,
}: {
  editor: ReactEditor;
  state: SelectionState;
  readOnly: boolean;
}) => {
  // Listen on the native `selectionchange` event to be able to update any time
  // the selection changes. This is required because React's `onSelect` is leaky
  // and non-standard so it doesn't fire until after a selection has been
  // released. This causes issues in situations where another change happens
  // while a selection is being dragged.

  const onDOMSelectionChange = useCallback(() => {
    if (
      readOnly ||
      state.isComposing ||
      state.ignoreSelection ||
      state.updatingSelection
    ) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "state",
        selection: editor.selection ?? null,
        state: debugState(state, editor),
      });
      return;
    }

    const domSelection = window.getSelection();
    if (!domSelection) {
      const editorSelection = editor.selection ?? null;
      const editorFocused = ReactEditor.isFocused(editor);
      if (editorFocused && editorSelection != null) {
        logSlateDebug("dom-selection-change:skip", {
          reason: "dom-selection-null",
          selection: editorSelection,
          activeElement: describeDomNode(window.document.activeElement),
          state: debugState(state, editor),
        });
        return;
      }
      logSlateDebug("dom-selection-change:deselect", {
        selection: editorSelection,
        state: debugState(state, editor),
      });
      withSelectionReason(editor, "dom-selection-change:deselect", () => {
        Transforms.deselect(editor);
      });
      return;
    }
    if (shouldIgnoreSelectionWhileTyping(state, domSelection)) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "typing-window",
        selection: editor.selection ?? null,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }
    const { anchorNode, focusNode } = domSelection;
    const editorElement = EDITOR_TO_ELEMENT.get(editor);
    if (
      (editorElement &&
        (anchorNode === editorElement || focusNode === editorElement)) ||
      (anchorNode?.nodeType === 1 &&
        (anchorNode as Element).getAttribute("data-slate-node") === "value") ||
      (focusNode?.nodeType === 1 &&
        (focusNode as Element).getAttribute("data-slate-node") === "value")
    ) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "root-node",
        selection: editor.selection ?? null,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    if (isInCodeMirror(anchorNode) || isInCodeMirror(focusNode)) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "codemirror",
        selection: editor.selection ?? null,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    if (!isSelectable(editor, anchorNode) || !isSelectable(editor, focusNode)) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "not-selectable",
        selection: editor.selection ?? null,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    let range;
    try {
      range = ReactEditor.toSlateRange(editor, domSelection);
    } catch (err) {
      // isSelectable should catch any situation where the above might cause an
      // error, but in practice it doesn't.  Just ignore selection change when this
      // happens.
      console.warn(`slate selection sync issue - ${err}`);
      logSlateDebug("dom-selection-change:skip", {
        reason: "to-slate-range-error",
        selection: editor.selection ?? null,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    const now = Date.now();
    const recentPointer =
      state.lastPointerDownAt != null &&
      now - state.lastPointerDownAt < POINTER_SELECTION_GRACE_MS;
    const recentSelectionKey =
      state.lastSelectionKeyAt != null &&
      now - state.lastSelectionKeyAt < SELECTION_KEY_GRACE_MS;
    if (
      domSelection.isCollapsed &&
      selection != null &&
      range != null &&
      !Range.equals(selection, range) &&
      !state.shiftKey &&
      !recentPointer &&
      !recentSelectionKey
    ) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "no-intent",
        selection,
        range,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    const lastSelectionChangeAt =
      (editor as any).lastSelectionChangeAt as number | undefined;
    if (
      domSelection.isCollapsed &&
      lastSelectionChangeAt != null &&
      Date.now() - lastSelectionChangeAt < SELECTION_SYNC_SUPPRESS_MS &&
      selection != null &&
      range != null &&
      !Range.equals(selection, range)
    ) {
      logSlateDebug("dom-selection-change:skip", {
        reason: "recent-slate-selection",
        selection,
        range,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      return;
    }

    // console.log(JSON.stringify({ range, sel: state.windowedSelection }));
    if (state.windowedSelection === true) {
      state.windowedSelection = range;
    }

    const { selection } = editor;
    if (selection != null) {
      const visibleRange = editor.windowedListRef.current?.visibleRange;
      if (visibleRange != null) {
        // Trickier case due to windowing.  If we're not changing the selection
        // via shift click but the selection in the DOM is trimmed due to windowing,
        // then make no change to editor.selection based on the DOM.
        if (
          !state.shiftKey &&
          state.windowedSelection != null &&
          isEqual(range, state.windowedSelection)
        ) {
          // selection is what was set using window clipping, so not changing
          return;
        }

        // Shift+clicking to select a range, done via code that works in
        // case of windowing.
        if (state.shiftKey) {
          // What *should* actually happen on shift+click to extend a
          // selection is not so obvious!  For starters, the behavior
          // in text editors like CodeMirror, VSCode and Ace Editor
          // (set range.anchor to selection.anchor) is totally different
          // than rich editors like Word, Pages, and browser
          // contenteditable, which mostly *extend* the selection in
          // various ways.  We match exactly what default browser
          // selection does, since otherwise we would have to *change*
          // that when not using windowing or when everything is in
          // the visible window, which seems silly.
          const edges = Range.edges(selection);
          if (Point.isBefore(range.focus, edges[0])) {
            // Shift+click before the entire existing selection:
            range.anchor = edges[1];
          } else if (Point.isAfter(range.focus, edges[1])) {
            // Shift+click after the entire existing selection:
            range.anchor = edges[0];
          } else {
            // Shift+click inside the existing selection.  What browsers
            // do is they shrink selection so the new focus is
            // range.focus, and the new anchor is whichever of
            // selection.focus or selection.anchor makes the resulting
            // selection "longer".
            const a = Editor.string(
              editor,
              { focus: range.focus, anchor: selection.anchor },
              { voids: true },
            ).length;
            const b = Editor.string(
              editor,
              { focus: range.focus, anchor: selection.focus },
              { voids: true },
            ).length;
            range.anchor = a > b ? selection.anchor : selection.focus;
          }
        }
      }
    }

    if (
      selection != null &&
      range != null &&
      !Range.equals(selection, range) &&
      shouldLogSelectionMismatch(editor, selection, range, state)
    ) {
      logSelectionMismatch(editor, selection, range, domSelection, state);
    }

    if (selection == null || !Range.equals(selection, range)) {
      logSlateDebug("dom-selection-change:apply", {
        selection: selection ?? null,
        range,
        domSelection: describeDomSelection(domSelection),
        activeElement: describeDomNode(window.document.activeElement),
        state: debugState(state, editor),
      });
      withSelectionReason(editor, "dom-selection-change", () => {
        Transforms.select(editor, range);
      });
    }
  }, [readOnly]);

  // Attach a native DOM event handler for `selectionchange`, because React's
  // built-in `onSelect` handler doesn't fire for all selection changes. It's a
  // leaky polyfill that only fires on keypresses or clicks. Instead, we want to
  // fire for any change to the selection inside the editor. (2019/11/04)
  // https://github.com/facebook/react/issues/5785
  useIsomorphicLayoutEffect(() => {
    const editorElement = EDITOR_TO_ELEMENT.get(editor);
    if (!editorElement) {
      return;
    }

    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      window.document.addEventListener("selectionchange", onDOMSelectionChange);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      window.document.removeEventListener(
        "selectionchange",
        onDOMSelectionChange,
      );
    };

    const handleFocusIn = () => {
      attach();
    };
    const handleFocusOut = () => {
      detach();
    };

    editorElement.addEventListener("focusin", handleFocusIn);
    editorElement.addEventListener("focusout", handleFocusOut);

    if (
      ReactEditor.isFocused(editor) ||
      editorElement.contains(window.document.activeElement)
    ) {
      attach();
    }

    return () => {
      detach();
      editorElement.removeEventListener("focusin", handleFocusIn);
      editorElement.removeEventListener("focusout", handleFocusOut);
    };
  }, [onDOMSelectionChange]);

  return onDOMSelectionChange;
};

function shouldIgnoreSelectionWhileTyping(
  state: SelectionState,
  domSelection: DOMSelection,
): boolean {
  if (!domSelection.isCollapsed) {
    return false;
  }
  const now = Date.now();
  if (state.lastPointerDownAt && now - state.lastPointerDownAt < POINTER_SELECTION_GRACE_MS) {
    return false;
  }
  if (
    state.lastSelectionKeyAt &&
    now - state.lastSelectionKeyAt < SELECTION_KEY_GRACE_MS
  ) {
    return false;
  }
  if (!state.lastUserInputAt) {
    return false;
  }
  return now - state.lastUserInputAt < TYPING_SELECTION_SUPPRESS_MS;
}

function debugState(state: SelectionState, editor?: ReactEditor) {
  const lastSelectionChangeAt =
    editor ? ((editor as any).lastSelectionChangeAt as number | undefined) : undefined;
  return {
    isComposing: state.isComposing,
    shiftKey: state.shiftKey,
    ignoreSelection: state.ignoreSelection,
    updatingSelection: state.updatingSelection,
    windowedSelection: state.windowedSelection != null,
    lastUserInputAt: state.lastUserInputAt,
    msSinceInput: state.lastUserInputAt
      ? Date.now() - state.lastUserInputAt
      : null,
    lastPointerDownAt: state.lastPointerDownAt,
    msSincePointerDown: state.lastPointerDownAt
      ? Date.now() - state.lastPointerDownAt
      : null,
    lastSelectionKeyAt: state.lastSelectionKeyAt,
    msSinceSelectionKey: state.lastSelectionKeyAt
      ? Date.now() - state.lastSelectionKeyAt
      : null,
    lastSelectionChangeAt,
    msSinceSelectionChange: lastSelectionChangeAt
      ? Date.now() - lastSelectionChangeAt
      : null,
  };
}

function getWindowedSelection(editor: ReactEditor): Selection | null {
  const { selection } = editor;
  if (selection == null || editor.windowedListRef?.current == null) {
    // No selection, or not using windowing, or collapsed so easy.
    return selection;
  }

  // Now we trim non-collapsed selection to part of window in the DOM.
  const visibleRange = editor.windowedListRef.current?.visibleRange;
  if (visibleRange == null) return selection;
  const { anchor, focus } = selection;
  return {
    anchor: clipPoint(editor, anchor, visibleRange),
    focus: clipPoint(editor, focus, visibleRange),
  };
}

function clipPoint(
  editor: Editor,
  point: Point,
  visibleRange: { startIndex: number; endIndex: number },
): Point {
  const { startIndex, endIndex } = visibleRange;
  const n = point.path[0];
  if (n < startIndex) {
    return { path: [startIndex, 0], offset: 0 };
  }
  if (n > endIndex) {
    // We have to use Editor.before, since we need to select
    // the entire endIndex block.  The ?? below should just be
    // to make typescript happy.
    return (
      Editor.before(editor, { path: [endIndex + 1, 0], offset: 0 }) ?? {
        path: [endIndex, 0],
        offset: 0,
      }
    );
  }
  return point;
}

function isSelectable(editor, node): boolean {
  return hasEditableTarget(editor, node) || isTargetInsideVoid(editor, node);
}

function isInCodeMirror(node: Node | null): boolean {
  if (!node) return false;
  const element =
    node.nodeType === 1 ? (node as Element) : (node as Node).parentElement;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  return element.closest(".CodeMirror") != null;
}

type DomSelectionSnapshot = {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
};

function getDomSelectionSnapshot(
  domSelection: DOMSelection,
): DomSelectionSnapshot {
  return {
    anchorNode: domSelection.anchorNode,
    anchorOffset: domSelection.anchorOffset,
    focusNode: domSelection.focusNode,
    focusOffset: domSelection.focusOffset,
  };
}

function domSelectionMatchesSnapshot(
  current: DomSelectionSnapshot,
  last: DomSelectionSnapshot | null,
): boolean {
  if (!last) return false;
  return (
    current.anchorNode === last.anchorNode &&
    current.anchorOffset === last.anchorOffset &&
    current.focusNode === last.focusNode &&
    current.focusOffset === last.focusOffset
  );
}

function recordSelectionState(
  selection: Selection | null | undefined,
  domSelection: DOMSelection,
  lastSelectionRef: { current: Selection | null | undefined },
  lastDomSelectionRef: { current: DomSelectionSnapshot | null },
): void {
  lastSelectionRef.current = selection ?? null;
  lastDomSelectionRef.current = getDomSelectionSnapshot(domSelection);
}

const SELECTION_MISMATCH_LOG_INTERVAL_MS = 2000;
let lastSelectionMismatchLog = 0;
let suppressedSelectionMismatchLogs = 0;

function shouldLogSelectionMismatch(
  editor: ReactEditor,
  selection: Range,
  range: Range,
  state: SelectionState,
): boolean {
  if (!LOG_SELECTION_MISMATCHES) {
    return false;
  }
  if (
    state.shiftKey ||
    state.isComposing ||
    state.ignoreSelection ||
    state.updatingSelection ||
    state.windowedSelection != null
  ) {
    return false;
  }
  if (!ReactEditor.isFocused(editor)) {
    return false;
  }
  if (!Range.isCollapsed(selection) || !Range.isCollapsed(range)) {
    return false;
  }
  const samePath = Path.equals(selection.anchor.path, range.anchor.path);
  const offsetDiff = Math.abs(selection.anchor.offset - range.anchor.offset);
  if (samePath && offsetDiff <= 1) {
    // Likely normal caret movement while typing.
    return false;
  }
  return true;
}

function logSelectionMismatch(
  editor: ReactEditor,
  selection: Range,
  range: Range,
  domSelection: DOMSelection,
  state: SelectionState,
): void {
  const now = Date.now();
  if (now - lastSelectionMismatchLog < SELECTION_MISMATCH_LOG_INTERVAL_MS) {
    suppressedSelectionMismatchLogs += 1;
    return;
  }
  const suppressed = suppressedSelectionMismatchLogs;
  suppressedSelectionMismatchLogs = 0;
  lastSelectionMismatchLog = now;

  const visibleRange = editor.windowedListRef?.current?.visibleRange;
  console.warn("SLATE selection mismatch (DOM vs Slate)", {
    selection,
    range,
    domSelection: describeDomSelection(domSelection),
    editorFocused: ReactEditor.isFocused(editor),
    windowed: editor.windowedListRef?.current != null,
    visibleRange,
    state: {
      shiftKey: state.shiftKey,
      isComposing: state.isComposing,
      ignoreSelection: state.ignoreSelection,
      updatingSelection: state.updatingSelection,
      windowedSelection: state.windowedSelection,
    },
    suppressed,
  });
}

function scheduleSelectionReset(state: SelectionState): void {
  if (state.pendingSelectionReset) return;
  state.pendingSelectionReset = true;
  const reset = () => {
    state.updatingSelection = false;
    state.pendingSelectionReset = false;
  };
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    window.requestAnimationFrame(reset);
  } else {
    setTimeout(reset, 0);
  }
}
