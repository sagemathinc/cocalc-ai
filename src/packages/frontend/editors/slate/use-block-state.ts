/*
 * This hook owns the block-level markdown state for the block editor.
 * It handles splitting/joining markdown into blocks, generating stable block ids,
 * and tracking per-block remote versions used by sync logic.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  splitMarkdownToBlocks,
  splitMarkdownToBlocksIncremental,
} from "./block-chunking";

interface UseBlockStateOptions {
  initialValue: string;
  valueRef: React.MutableRefObject<string>;
}

export function useBlockState({ initialValue, valueRef }: UseBlockStateOptions) {
  const nextBlockIdRef = useRef<number>(1);
  const newBlockId = useCallback(
    () => `b${nextBlockIdRef.current++}`,
    [],
  );
  const [blocks, setBlocks] = useState<string[]>(() =>
    splitMarkdownToBlocks(initialValue),
  );
  const blocksRef = useRef<string[]>(blocks);
  const [blockIds, setBlockIds] = useState<string[]>(() =>
    blocks.map(() => newBlockId()),
  );
  const blockIdsRef = useRef<string[]>(blockIds);
  const remoteVersionRef = useRef<number[]>(blocks.map(() => 0));

  const syncRemoteVersionLength = useCallback((nextBlocks: string[]) => {
    const prevVersions = remoteVersionRef.current;
    if (prevVersions.length === nextBlocks.length) return;
    remoteVersionRef.current = nextBlocks.map((_, idx) => prevVersions[idx] ?? 0);
  }, []);

  const bumpRemoteVersionAt = useCallback((index: number, length: number) => {
    const prevVersions = remoteVersionRef.current;
    const next = [...prevVersions];
    while (next.length < length) {
      next.push(0);
    }
    next[index] = (next[index] ?? 0) + 1;
    remoteVersionRef.current = next;
  }, []);

  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);
  useEffect(() => {
    blockIdsRef.current = blockIds;
  }, [blockIds]);

  const bumpRemoteVersions = useCallback(
    (nextBlocks: string[]) => {
      const prevBlocks = blocksRef.current;
      const prevVersions = remoteVersionRef.current;
      if (nextBlocks.length !== prevBlocks.length) {
        remoteVersionRef.current = nextBlocks.map(
          (_, idx) => (prevVersions[idx] ?? 0) + 1,
        );
        return;
      }
      const nextVersions = nextBlocks.map((block, idx) => {
        if (block !== prevBlocks[idx]) return (prevVersions[idx] ?? 0) + 1;
        return prevVersions[idx] ?? 0;
      });
      remoteVersionRef.current = nextVersions;
    },
    [],
  );

  const updateBlockIdsForRemote = useCallback(
    (nextBlocks: string[]) => {
      const prevBlocks = blocksRef.current;
      const prevIds = blockIdsRef.current;
      const nextIds = nextBlocks.map((block, idx) => {
        if (prevBlocks[idx] === block) {
          return prevIds[idx] ?? newBlockId();
        }
        return newBlockId();
      });
      blockIdsRef.current = nextIds;
      setBlockIds(nextIds);
    },
    [newBlockId],
  );

  const setBlocksFromValue = useCallback(
    (markdown: string) => {
      if (markdown === valueRef.current && blocksRef.current.length > 0) {
        return;
      }
      const prevMarkdown = valueRef.current ?? "";
      const prevBlocks = blocksRef.current;
      valueRef.current = markdown;
      const nextBlocks =
        prevBlocks.length > 0 && prevMarkdown.length > 0
          ? splitMarkdownToBlocksIncremental(prevMarkdown, markdown, prevBlocks)
          : splitMarkdownToBlocks(markdown);
      bumpRemoteVersions(nextBlocks);
      blocksRef.current = nextBlocks;
      setBlocks(nextBlocks);
      updateBlockIdsForRemote(nextBlocks);
    },
    [bumpRemoteVersions, updateBlockIdsForRemote, valueRef],
  );

  return {
    blocks,
    setBlocks,
    blocksRef,
    blockIds,
    setBlockIds,
    blockIdsRef,
    remoteVersionRef,
    newBlockId,
    syncRemoteVersionLength,
    bumpRemoteVersionAt,
    setBlocksFromValue,
  };
}
