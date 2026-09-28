/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useContext, useEffect, useRef, useState } from "react";
import type { CollaborationPage } from "@cocalc/util/collaborators";
import { DirectoryRevisionContext } from "./use-directory-revision";

function directoryItemKey<T>(item: T): string {
  if (item && typeof item === "object") {
    const row = item as Record<string, unknown>;
    if (row.resource_id)
      return JSON.stringify([row.project_id, row.kind, row.resource_id]);
    if (row.account_id) return String(row.account_id);
    if (row.project_id) return String(row.project_id);
  }
  return JSON.stringify(item);
}

export interface DirectoryPage<T> {
  page?: CollaborationPage<T>;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  pageNumber: number;
  next: () => void;
  refresh: () => void;
}

/** Results are account-mount scoped. Refresh the loaded prefix atomically so
 * access revalidation never leaves older pages outside the authorization fence.
 */
export function useDirectory<T>(
  key: string,
  load: (after?: string, signal?: AbortSignal) => Promise<CollaborationPage<T>>,
  enabled = true,
  keepAuthorizedWhileRefreshing = true,
  itemKey: (item: T) => string = directoryItemKey,
): DirectoryPage<T> {
  const epoch = useContext(DirectoryRevisionContext);
  enabled = enabled && epoch.ready;
  const loader = useRef(load);
  loader.current = load;
  const identify = useRef(itemKey);
  identify.current = itemKey;
  const [revision, setRevision] = useState(0);
  const activation = useRef({ enabled, key, sequence: 0 });
  if (activation.current.enabled !== enabled || activation.current.key !== key)
    activation.current = {
      enabled,
      key,
      sequence: activation.current.sequence + 1,
    };
  const identity = JSON.stringify([
    key,
    epoch.generation,
    revision,
    enabled,
    activation.current.sequence,
  ]);
  const latest = useRef(identity);
  latest.current = identity;
  type State = {
    identity: string;
    key: string;
    activation: number;
    page?: CollaborationPage<T>;
    pages: number;
    cursors: string[];
    loadingMore: boolean;
    error?: string;
  };
  const [state, setState] = useState<State>();
  const snapshot = useRef(state);
  snapshot.current = state;
  const pending = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const merge = (pages: CollaborationPage<T>[]) => {
    const items = new Map<string, T>();
    for (const page of pages)
      for (const item of page.items) items.set(identify.current(item), item);
    const incomplete =
      pages.find((page) => page.coverage === "indexing") ??
      pages.find((page) => page.coverage === "partial");
    return {
      ...pages[pages.length - 1],
      items: [...items.values()],
      ...(incomplete
        ? {
            coverage: incomplete.coverage,
            coverage_message: incomplete.coverage_message,
          }
        : {}),
    };
  };
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    abort.current = controller;
    const active = activation.current.sequence;
    const before = snapshot.current;
    const count =
      before?.key === key && before.activation === active ? before.pages : 1;
    const current = () =>
      !controller.signal.aborted && latest.current === identity;
    pending.current = identity;
    void (async () => {
      const pages: CollaborationPage<T>[] = [];
      const cursors: string[] = [];
      let after: string | undefined;
      for (let index = 0; index < count; index++) {
        const page = await loader.current(after, controller.signal);
        if (!current()) return;
        pages.push(page);
        if (after) cursors.push(after);
        if (!page.next) break;
        if (page.next === after || cursors.includes(page.next))
          throw Error(
            "The results cursor did not advance. Refresh to try again.",
          );
        after = page.next;
      }
      if (current())
        setState({
          identity,
          key,
          activation: active,
          page: merge(pages),
          pages: pages.length,
          cursors,
          loadingMore: false,
        });
    })()
      .catch((error) => {
        if (current())
          setState({
            identity,
            key,
            activation: active,
            pages: 1,
            cursors: [],
            loadingMore: false,
            error: String(error),
          });
      })
      .finally(() => {
        if (pending.current === identity) pending.current = undefined;
      });
    return () => controller.abort();
  }, [identity]);

  const current = enabled && state?.identity === identity ? state : undefined;
  const retained =
    enabled &&
    keepAuthorizedWhileRefreshing &&
    state?.key === key &&
    state.activation === activation.current.sequence
      ? state.page
      : undefined;
  return {
    page: current?.page ?? (!current ? retained : undefined),
    loading: enabled && !current,
    loadingMore: current?.loadingMore ?? false,
    error: current?.error,
    pageNumber: current?.pages ?? 1,
    next: () => {
      const before = snapshot.current;
      const after = before?.page?.next;
      if (
        !enabled ||
        !before ||
        before.identity !== identity ||
        !after ||
        pending.current === identity ||
        before.error
      )
        return;
      if (before.cursors.includes(after)) return;
      pending.current = identity;
      const signal = abort.current?.signal;
      const valid = () => latest.current === identity && !signal?.aborted;
      setState({ ...before, loadingMore: true });
      // Invoke this filter's loader now; an async wrapper also catches a
      // synchronous authorization/validation error before an RPC is returned.
      void (async () => loader.current(after, signal))()
        .then((page) => {
          if (!valid()) return;
          if (
            page.next === after ||
            (page.next && before.cursors.includes(page.next))
          )
            throw Error(
              "The results cursor did not advance. Refresh to try again.",
            );
          setState({
            ...before,
            page: merge([before.page!, page]),
            pages: before.pages + 1,
            cursors: [...before.cursors, after],
            loadingMore: false,
          });
        })
        .catch((error) => {
          // An unsuccessful access-bound read must not leave stale results visible.
          if (valid())
            setState({
              ...before,
              page: undefined,
              loadingMore: false,
              error: String(error),
            });
        })
        .finally(() => {
          if (pending.current === identity) pending.current = undefined;
        });
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
