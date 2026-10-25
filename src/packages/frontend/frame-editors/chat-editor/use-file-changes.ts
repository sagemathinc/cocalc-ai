/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A card that shows a saved file (a todo list, a calendar, a document) follows
the file: when it changes on disk, the card reloads it, without Refresh. It
watches the file through the project's filesystem while the card is shown.
*/

import { useEffect, useRef } from "react";
import { useProjectContext } from "@cocalc/frontend/project/context";

// A burst of writes (an agent saving twice, an editor's temp-file rename)
// reloads once.
export const FILE_CHANGE_DEBOUNCE_MS = 300;
// After the watch fails or ends (the file was deleted, the project
// restarted), try again this much later.
export const FILE_WATCH_RETRY_MS = 5_000;

export function useFileChanges(
  path: string,
  onChange: () => void,
  enabled = true,
): void {
  const { actions } = useProjectContext();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!enabled || !path) return;
    let closed = false;
    let watcher: { close?: () => void } | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // The watch lapsed: a change may have been missed (the file replaced by
    // a rename, say), so reload once when watching again.
    let lapsed = false;
    const changed = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        if (!closed) onChangeRef.current();
      }, FILE_CHANGE_DEBOUNCE_MS);
    };
    const watch = async () => {
      try {
        const fs = actions?.fs();
        if (!fs) return;
        const iterator = await fs.watch(path);
        if (closed) {
          iterator.close?.();
          return;
        }
        watcher = iterator;
        if (lapsed) {
          lapsed = false;
          changed();
        }
        for await (const _event of iterator) {
          if (closed) break;
          // Any event, deletion included: the reload shows what is there now.
          changed();
        }
      } catch {
        // Not watchable now (no such file yet, project stopped): retry.
      } finally {
        watcher?.close?.();
        watcher = undefined;
      }
      if (!closed) {
        lapsed = true;
        retry = setTimeout(watch, FILE_WATCH_RETRY_MS);
      }
    };
    void watch();
    return () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
      watcher?.close?.();
    };
  }, [actions, path, enabled]);
}
