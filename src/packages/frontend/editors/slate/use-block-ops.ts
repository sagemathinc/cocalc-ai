/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Block mutation operations (insert, delete, merge, set text) live here.
// These helpers manage block arrays, ids, versions, and focus behavior so the
// core editor component focuses on wiring and rendering.

import { useCallback } from "react";
import { Editor, Node, Path, Transforms } from "slate";
import { ReactEditor } from "./slate-react";
import type { SlateEditor } from "./types";

export function useBlockOps({
  blocksRef,
  blockIdsRef,
  editorMapRef,
  pendingSelectionRef,
  pendingFocusRef,
  skipSelectionResetRef,
  setBlocks,
  setBlockIds,
  setFocusedIndex,
  setSelectionAtOffset,
  setGapCursorState,
  syncRemoteVersionLength,
  bumpRemoteVersionAt,
  markLocalEdit,
  saveBlocksDebounced,
  newBlockId,
  is_current,
  virtuosoRef,
}: {
  blocksRef: React.MutableRefObject<string[]>;
  blockIdsRef: React.MutableRefObject<string[]>;
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  pendingSelectionRef: React.MutableRefObject<
    | { index: number; offset: number; endOffset?: number; mode: "text" }
    | {
        index: number;
        pos: { line: number; ch: number };
        endPos?: { line: number; ch: number };
        mode: "markdown";
      }
    | null
  >;
  pendingFocusRef: React.MutableRefObject<{
    index: number;
    position: "start" | "end";
  } | null>;
  skipSelectionResetRef: React.MutableRefObject<Set<number>>;
  setBlocks: React.Dispatch<React.SetStateAction<string[]>>;
  setBlockIds: React.Dispatch<React.SetStateAction<string[]>>;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setSelectionAtOffset: (index: number, offset: number) => boolean;
  setGapCursorState: (
    gap: { index: number; side: "before" | "after"; path?: number[] } | null,
  ) => void;
  syncRemoteVersionLength: (nextBlocks: string[]) => void;
  bumpRemoteVersionAt: (index: number, length: number) => void;
  markLocalEdit: () => void;
  saveBlocksDebounced: () => void;
  newBlockId: () => string;
  is_current?: boolean;
  virtuosoRef: React.MutableRefObject<{ scrollToIndex: (opts: any) => void } | null>;
}) {
  const insertBlockAtGap = useCallback(
    (
      gap: { index: number; side: "before" | "after" },
      initialText?: string,
      focusPosition?: "start" | "end",
    ) => {
      markLocalEdit();
      setGapCursorState(null);
      const insertIndex = gap.side === "before" ? gap.index : gap.index + 1;
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, initialText ?? "");
        blocksRef.current = next;
        return next;
      });
      setBlockIds((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, newBlockId());
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
      const position: "start" | "end" =
        focusPosition ?? (initialText ? "end" : "start");
      pendingFocusRef.current = {
        index: insertIndex,
        position,
      };
      virtuosoRef.current?.scrollToIndex({
        index: insertIndex,
        align: "center",
      });
    },
    [
      blocksRef,
      blockIdsRef,
      is_current,
      markLocalEdit,
      newBlockId,
      pendingFocusRef,
      saveBlocksDebounced,
      setBlocks,
      setBlockIds,
      setGapCursorState,
      syncRemoteVersionLength,
      virtuosoRef,
    ],
  );

  const setBlockText = useCallback(
    (index: number, text: string) => {
      if (index < 0) return;
      markLocalEdit();
      skipSelectionResetRef.current.add(index);
      setBlocks((prev) => {
        const next = [...prev];
        while (next.length <= index) {
          next.push("");
        }
        next[index] = text;
        blocksRef.current = next;
        bumpRemoteVersionAt(index, next.length);
        return next;
      });
      setBlockIds((prev) => {
        if (prev.length >= blocksRef.current.length) return prev;
        const next = [...prev];
        while (next.length < blocksRef.current.length) {
          next.push(newBlockId());
        }
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
    },
    [
      blocksRef,
      blockIdsRef,
      bumpRemoteVersionAt,
      is_current,
      markLocalEdit,
      newBlockId,
      saveBlocksDebounced,
      setBlocks,
      setBlockIds,
      skipSelectionResetRef,
      syncRemoteVersionLength,
    ],
  );

  const deleteBlockAtIndex = useCallback(
    (index: number, opts?: { focus?: boolean }) => {
      if (index < 0 || index >= blocksRef.current.length) return;
      if (blocksRef.current.length === 1) return;
      markLocalEdit();
      setGapCursorState(null);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        blocksRef.current = next;
        return next;
      });
      setBlockIds((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
      if (opts?.focus === false) return;
      const targetIndex = Math.max(0, index - 1);
      pendingFocusRef.current = { index: targetIndex, position: "end" };
      virtuosoRef.current?.scrollToIndex({
        index: targetIndex,
        align: "center",
      });
    },
    [
      blocksRef,
      blockIdsRef,
      is_current,
      markLocalEdit,
      pendingFocusRef,
      saveBlocksDebounced,
      setBlocks,
      setBlockIds,
      setGapCursorState,
      syncRemoteVersionLength,
      virtuosoRef,
    ],
  );

  const mergeWithPreviousBlock = useCallback(
    (index: number) => {
      if (index <= 0) return;
      const prevEditor = editorMapRef.current.get(index - 1);
      const currEditor = editorMapRef.current.get(index);
      if (!prevEditor || !currEditor) return;

      markLocalEdit();
      setGapCursorState(null);

      const insertIndex = prevEditor.children.length;
      const insertPath: Path = [insertIndex];
      const mergeOffset = (blocksRef.current[index - 1] ?? "").length;
      const boundaryPoint = (() => {
        const texts = Array.from(Node.texts(prevEditor));
        for (let i = texts.length - 1; i >= 0; i -= 1) {
          const [node, path] = texts[i];
          if (node.text.length > 0) {
            return { path, offset: node.text.length };
          }
        }
        return Editor.end(prevEditor, Path.previous(insertPath));
      })();
      const boundaryRef = Editor.pointRef(prevEditor, boundaryPoint, {
        affinity: "backward",
      });
      pendingSelectionRef.current = {
        index: index - 1,
        offset: mergeOffset,
        mode: "text",
      };
      const inserted = currEditor.children.map((node) =>
        JSON.parse(JSON.stringify(node)),
      );
      try {
        Transforms.setSelection(prevEditor, {
          anchor: boundaryPoint,
          focus: boundaryPoint,
        });
        Transforms.insertFragment(prevEditor, inserted);
        const point = boundaryRef.current;
        if (point) {
          Transforms.setSelection(prevEditor, { anchor: point, focus: point });
        }
        ReactEditor.focus(prevEditor);
        setFocusedIndex(index - 1);
      } catch {
        // If we cannot merge, leave selection unchanged.
      } finally {
        boundaryRef.unref();
      }

      deleteBlockAtIndex(index, { focus: false });
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          setSelectionAtOffset(index - 1, mergeOffset);
        }, 0);
      } else {
        setSelectionAtOffset(index - 1, mergeOffset);
      }
    },
    [
      blocksRef,
      deleteBlockAtIndex,
      editorMapRef,
      markLocalEdit,
      pendingSelectionRef,
      setFocusedIndex,
      setGapCursorState,
      setSelectionAtOffset,
    ],
  );

  return {
    insertBlockAtGap,
    setBlockText,
    deleteBlockAtIndex,
    mergeWithPreviousBlock,
  };
}
