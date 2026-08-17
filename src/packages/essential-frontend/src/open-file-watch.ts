/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { FilesystemClient } from "@cocalc/conat/files/fs";
import type { ChangeEvent, WatchIterator } from "@cocalc/conat/files/watch";

export interface OpenFileWatchOptions {
  filesystem: FilesystemClient;
  onChange: (event: ChangeEvent) => void;
  onError?: (error: unknown) => void;
  path: string;
  settleMs?: number;
}

// One direct project-host subscription exists only while its file surface is
// mounted. Bursts are collapsed so atomic-save rename sequences cause one UI
// update rather than repeated file reads.
export function startOpenFileWatch({
  filesystem,
  onChange,
  onError,
  path,
  settleMs = 250,
}: OpenFileWatchOptions): () => void {
  let closed = false;
  let watcher: WatchIterator | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ChangeEvent | undefined;

  const emit = (event: ChangeEvent) => {
    if (closed || event.ignore) return;
    if (settleMs <= 0) {
      onChange(event);
      return;
    }
    pending = event;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const next = pending;
      pending = undefined;
      if (!closed && next) onChange(next);
    }, settleMs);
  };

  void filesystem
    .watch(path, {
      // Editors and uploaders commonly save through unlink/rename/add. Keep
      // following this path until the visible surface itself closes.
      closeOnUnlink: false,
      maxQueue: 4,
      overflow: "ignore",
      stabilityThreshold: 400,
      unique: false,
    })
    .then(async (value) => {
      watcher = value;
      if (closed) {
        watcher.close();
        return;
      }
      for await (const event of watcher) {
        emit(event);
      }
      if (!closed) {
        onError?.(new Error("The project-host file watch ended."));
      }
    })
    .catch((error) => {
      if (!closed) onError?.(error);
    });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
    watcher?.close();
  };
}
