/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useContext, useEffect, useRef, useState } from "react";
import type { CollaborationPage } from "@cocalc/util/collaborators";
import { DirectoryRevisionContext } from "./use-directory-revision";

export interface DirectoryPage<T> {
  page?: CollaborationPage<T>;
  loading: boolean;
  error?: string;
  pageNumber: number;
  previous: () => void;
  next: () => void;
  refresh: () => void;
}

/** No module/global result cache: metadata lives only in this account's mount.
 * RPCs cannot be aborted on the wire; invalidated results must never be applied.
 */
export function useDirectory<T>(
  key: string,
  load: (after?: string, signal?: AbortSignal) => Promise<CollaborationPage<T>>,
  enabled = true,
  keepAuthorizedWhileRefreshing = true,
): DirectoryPage<T> {
  const epoch = useContext(DirectoryRevisionContext);
  const targetKey = key;
  key = JSON.stringify([key, epoch.generation]);
  enabled = enabled && epoch.ready;
  const activation = useRef({ enabled, targetKey, sequence: 0 });
  if (
    activation.current.enabled !== enabled ||
    activation.current.targetKey !== targetKey
  )
    activation.current = {
      enabled,
      targetKey,
      sequence: activation.current.sequence + 1,
    };
  const loader = useRef(load);
  loader.current = load;
  const [position, setPosition] = useState<{
    key: string;
    cursors: (string | undefined)[];
  }>({ key: targetKey, cursors: [undefined] });
  const cursors = position.key === targetKey ? position.cursors : [undefined];
  const after = cursors[cursors.length - 1];
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([key, after, revision, enabled]);
  const generation = useRef({ identity, sequence: 0 });
  if (generation.current.identity !== identity) {
    generation.current = {
      identity,
      sequence: generation.current.sequence + 1,
    };
  }
  const requestKey = JSON.stringify([identity, generation.current.sequence]);
  const [state, setState] = useState<{
    key: string;
    targetKey: string;
    after?: string;
    activation: number;
    page?: CollaborationPage<T>;
    error?: string;
  }>();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const abort = new AbortController();
    const loadPage = loader.current;
    const activeSequence = activation.current.sequence;
    void Promise.resolve()
      .then(() => loadPage(after, abort.signal))
      .then(
        (page) => {
          if (!cancelled)
            setState({
              key: requestKey,
              targetKey,
              after,
              activation: activeSequence,
              page,
            });
        },
        (error) => {
          if (!cancelled)
            setState({
              key: requestKey,
              targetKey,
              after,
              activation: activeSequence,
              error: String(error),
            });
        },
      );
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [requestKey]);

  const current = enabled && state?.key === requestKey ? state : undefined;
  // Refresh in place. Never retain across account/filter/page changes, an
  // inactive interval, failed access checks, or a rejected page read.
  const retained =
    enabled &&
    keepAuthorizedWhileRefreshing &&
    state?.targetKey === targetKey &&
    state.after === after &&
    state.activation === activation.current.sequence
      ? state.page
      : undefined;
  return {
    page: current?.page ?? (!current ? retained : undefined),
    loading: enabled && !current,
    error: current?.error,
    pageNumber: cursors.length,
    previous: () => {
      if (cursors.length > 1)
        setPosition({ key: targetKey, cursors: cursors.slice(0, -1) });
    },
    next: () => {
      const next = current?.page?.next;
      if (next && next !== after)
        setPosition({ key: targetKey, cursors: [...cursors, next] });
    },
    refresh: () => setRevision((n) => n + 1),
  };
}

export function useDirectorySearch(value: string): string {
  const [search, setSearch] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(value.trim()), 250);
    return () => clearTimeout(timer);
  }, [value]);
  return search;
}
