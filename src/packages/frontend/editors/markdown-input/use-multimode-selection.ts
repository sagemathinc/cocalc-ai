import { MutableRefObject, useEffect, useLayoutEffect, useRef } from "react";
import {
  restoreSelectionWithRetry,
  retrySelectionApply,
} from "./selection-utils";
import type {
  MarkdownPosition,
  Mode,
  RichTextSelectionBridgeControl,
  SelectionController,
  SubscribeSelectionReady,
} from "./types";

interface PendingSelection {
  to: Mode;
  pos: MarkdownPosition;
}

interface UseMultimodeSelectionOptions {
  cacheId?: string;
  mode: Mode;
  getCachedSelection: () => any;
  saveCachedSelection: (selection: any) => void;
  richTextControlRef: MutableRefObject<RichTextSelectionBridgeControl | null>;
}

export function useMultimodeSelection({
  cacheId,
  mode,
  getCachedSelection,
  saveCachedSelection,
  richTextControlRef,
}: UseMultimodeSelectionOptions) {
  const selectionRef = useRef<SelectionController | null>(null);
  const pendingModeSelectionRef = useRef<PendingSelection | null>(null);
  const modeSwitchSelectionRef = useRef<MarkdownPosition | null>(null);
  const markdownReadyListenersRef = useRef<Set<() => void>>(new Set());
  const richTextReadyListenersRef = useRef<Set<() => void>>(new Set());

  const subscribeMarkdownReady: SubscribeSelectionReady = (callback) => {
    markdownReadyListenersRef.current.add(callback);
    return () => {
      markdownReadyListenersRef.current.delete(callback);
    };
  };

  const subscribeRichTextReady: SubscribeSelectionReady = (callback) => {
    richTextReadyListenersRef.current.add(callback);
    return () => {
      richTextReadyListenersRef.current.delete(callback);
    };
  };

  function emitReady(listeners: Set<() => void>) {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }

  function applyMarkdownSelection(pos: MarkdownPosition) {
    const selection = selectionRef.current;
    if (selection?.setSelection == null) {
      return false;
    }
    selection.focus?.();
    selection.setSelection([{ anchor: pos, head: pos }]);
    return true;
  }

  function stabilizePendingSelection(to: Mode, pos: MarkdownPosition) {
    if (typeof window === "undefined") {
      return;
    }
    window.setTimeout(() => {
      if (to === "editor") {
        richTextControlRef.current?.setSelectionFromMarkdownPosition?.(pos);
      } else {
        applyMarkdownSelection(pos);
      }
    }, 0);
  }

  function getMarkdownPositionForActiveSelection(): MarkdownPosition | null {
    if (mode === "editor") {
      return richTextControlRef.current?.getMarkdownPositionForSelection?.() ?? null;
    }
    const selection = selectionRef.current?.getSelection?.();
    const primary =
      (Array.isArray(selection) ? selection[0] : selection) ??
      null;
    const point = primary?.head ?? primary?.anchor ?? null;
    if (
      point == null ||
      typeof point.line !== "number" ||
      typeof point.ch !== "number"
    ) {
      return null;
    }
    return { line: point.line, ch: point.ch };
  }

  useLayoutEffect(() => {
    const pending = pendingModeSelectionRef.current;
    if (!pending || pending.to !== mode) {
      return;
    }
    if (mode === "editor") {
      return retrySelectionApply({
        isReady: () =>
          richTextControlRef.current?.isSelectionReady?.() ?? true,
        subscribeReady: subscribeRichTextReady,
        apply: () => {
          const applied =
            richTextControlRef.current?.setSelectionFromMarkdownPosition?.(
              pending.pos,
            ) ?? false;
          if (applied) {
            pendingModeSelectionRef.current = null;
            stabilizePendingSelection("editor", pending.pos);
          }
          return applied;
        },
      });
    }
    return retrySelectionApply({
      isReady: () => selectionRef.current?.isSelectionReady?.() ?? true,
      subscribeReady: subscribeMarkdownReady,
      apply: () => {
        const applied = applyMarkdownSelection(pending.pos);
        if (applied) {
          pendingModeSelectionRef.current = null;
          stabilizePendingSelection("markdown", pending.pos);
        }
        return applied;
      },
    });
  }, [mode, richTextControlRef]);

  useEffect(() => {
    if (cacheId == null) {
      return;
    }
    let cancelRestore = () => {};
    const cachedSelection = getCachedSelection();
    if (cachedSelection != null) {
      cancelRestore = restoreSelectionWithRetry({
        getController: () => selectionRef.current,
        selection: cachedSelection,
        subscribeReady:
          mode === "editor" ? subscribeRichTextReady : subscribeMarkdownReady,
      });
    }
    return () => {
      cancelRestore();
      if (selectionRef.current == null || cacheId == null) {
        return;
      }
      saveCachedSelection(selectionRef.current.getSelection());
    };
  }, [cacheId, mode, getCachedSelection, saveCachedSelection]);

  return {
    selectionRef,
    rememberPendingSelection: (to: Mode, pos: MarkdownPosition) => {
      pendingModeSelectionRef.current = { to, pos };
    },
    captureModeSwitchSelection: () => {
      modeSwitchSelectionRef.current = getMarkdownPositionForActiveSelection();
    },
    rememberSelectionForModeSwitch: (to: Mode) => {
      const pos = modeSwitchSelectionRef.current ?? getMarkdownPositionForActiveSelection();
      modeSwitchSelectionRef.current = null;
      if (pos != null) {
        pendingModeSelectionRef.current = { to, pos };
      }
    },
    getMarkdownPositionForSelection: () => {
      return richTextControlRef.current?.getMarkdownPositionForSelection?.();
    },
    notifyMarkdownSelectionReady: () => {
      emitReady(markdownReadyListenersRef.current);
    },
    notifyRichTextSelectionReady: () => {
      emitReady(richTextReadyListenersRef.current);
    },
  };
}
