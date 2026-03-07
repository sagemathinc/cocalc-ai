import { MutableRefObject, useEffect, useRef } from "react";
import {
  restoreSelectionWithRetry,
  retrySelectionApply,
} from "./selection-utils";
import type {
  MarkdownPosition,
  Mode,
  RichTextSelectionBridgeControl,
  SelectionController,
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

  function applyMarkdownSelection(pos: MarkdownPosition) {
    const selection = selectionRef.current;
    if (selection?.setSelection == null) {
      return false;
    }
    selection.setSelection([{ anchor: pos, head: pos }]);
    return true;
  }

  useEffect(() => {
    const pending = pendingModeSelectionRef.current;
    if (!pending || pending.to !== mode) {
      return;
    }
    if (mode === "editor") {
      return retrySelectionApply({
        apply: () => {
          const applied =
            richTextControlRef.current?.setSelectionFromMarkdownPosition?.(
              pending.pos,
            ) ?? false;
          if (applied) {
            pendingModeSelectionRef.current = null;
          }
          return applied;
        },
      });
    }
    return retrySelectionApply({
      apply: () => {
        const applied = applyMarkdownSelection(pending.pos);
        if (applied) {
          pendingModeSelectionRef.current = null;
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
    if (cachedSelection != null && selectionRef.current != null) {
      cancelRestore = restoreSelectionWithRetry({
        getController: () => selectionRef.current,
        selection: cachedSelection,
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
    getMarkdownPositionForSelection: () => {
      return richTextControlRef.current?.getMarkdownPositionForSelection?.();
    },
  };
}
