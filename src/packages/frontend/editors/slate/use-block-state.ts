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
import { debugSyncLog, summarizeMarkdown } from "./block-sync-utils";

interface UseBlockStateOptions {
  initialValue: string;
  valueRef: React.MutableRefObject<string>;
  blockChunkTargetChars?: number;
}

export function useBlockState({
  initialValue,
  valueRef,
  blockChunkTargetChars,
}: UseBlockStateOptions) {
  const nextBlockIdRef = useRef<number>(1);
  const newBlockId = useCallback(() => `b${nextBlockIdRef.current++}`, []);
  const [blocks, setBlocks] = useState<string[]>(() =>
    splitMarkdownToBlocks(initialValue, { targetChars: blockChunkTargetChars }),
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
    remoteVersionRef.current = nextBlocks.map(
      (_, idx) => prevVersions[idx] ?? 0,
    );
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

  const bumpRemoteVersions = useCallback((nextBlocks: string[]) => {
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
  }, []);

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
        debugSyncLog("state:set-blocks-from-value:skip-same-value", {
          blocksLength: blocksRef.current.length,
          markdown: summarizeMarkdown(markdown),
        });
        return;
      }
      const prevMarkdown = valueRef.current ?? "";
      const prevBlocks = blocksRef.current;
      debugSyncLog("state:set-blocks-from-value:start", {
        prevBlocksLength: prevBlocks.length,
        previous: summarizeMarkdown(prevMarkdown),
        next: summarizeMarkdown(markdown),
      });
      valueRef.current = markdown;
      const nextBlocks =
        prevBlocks.length > 0 && prevMarkdown.length > 0
          ? splitMarkdownToBlocksIncremental(
              prevMarkdown,
              markdown,
              prevBlocks,
              {
                targetChars: blockChunkTargetChars,
              },
            )
          : splitMarkdownToBlocks(markdown, {
              targetChars: blockChunkTargetChars,
            });
      debugSyncLog("state:set-blocks-from-value:parsed", {
        prevBlocksLength: prevBlocks.length,
        nextBlocksLength: nextBlocks.length,
        previousLastBlock: prevBlocks[prevBlocks.length - 1]
          ?.slice(-80)
          .replace(/\n/g, "\\n"),
        nextLastBlock: nextBlocks[nextBlocks.length - 1]
          ?.slice(-80)
          .replace(/\n/g, "\\n"),
      });
      bumpRemoteVersions(nextBlocks);
      blocksRef.current = nextBlocks;
      setBlocks(nextBlocks);
      updateBlockIdsForRemote(nextBlocks);
    },
    [
      bumpRemoteVersions,
      blockChunkTargetChars,
      updateBlockIdsForRemote,
      valueRef,
    ],
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
