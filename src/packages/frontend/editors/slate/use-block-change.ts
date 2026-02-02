/*
 * This hook wires block-level change handling for the block editor.
 * It updates block text, keeps ids in sync, and triggers save/sync
 * bookkeeping when edits occur.
 */

import { useCallback } from "react";

interface UseBlockChangeOptions {
  readOnly?: boolean;
  isCurrent?: boolean;
  blocksRef: React.MutableRefObject<string[]>;
  setBlocks: React.Dispatch<React.SetStateAction<string[]>>;
  blockIdsRef: React.MutableRefObject<string[]>;
  setBlockIds: React.Dispatch<React.SetStateAction<string[]>>;
  newBlockId: () => string;
  syncRemoteVersionLength: (blocks: string[]) => void;
  markLocalEdit: () => void;
  saveBlocksDebounced: () => void;
  skipSelectionResetRef: React.MutableRefObject<Set<number>>;
}

export function useBlockChange({
  readOnly,
  isCurrent,
  blocksRef,
  setBlocks,
  blockIdsRef,
  setBlockIds,
  newBlockId,
  syncRemoteVersionLength,
  markLocalEdit,
  saveBlocksDebounced,
  skipSelectionResetRef,
}: UseBlockChangeOptions) {
  const handleBlockChange = useCallback(
    (index: number, markdown: string) => {
      if (readOnly) return;
      markLocalEdit();
      skipSelectionResetRef.current.add(index);
      setBlocks((prev) => {
        if (index >= prev.length) return prev;
        if (prev[index] === markdown) return prev;
        const next = [...prev];
        next[index] = markdown;
        blocksRef.current = next;
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
      if (isCurrent) saveBlocksDebounced();
    },
    [
      blocksRef,
      blockIdsRef,
      isCurrent,
      markLocalEdit,
      newBlockId,
      readOnly,
      saveBlocksDebounced,
      setBlockIds,
      setBlocks,
      skipSelectionResetRef,
      syncRemoteVersionLength,
    ],
  );

  return { handleBlockChange };
}
