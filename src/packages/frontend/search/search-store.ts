/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether the search results page is showing, for which query, and which
// kind of thing comes first (the page the search started from).

import { useSyncExternalStore } from "react";

export type SearchScope = "agents" | "projects" | "artifacts" | "people";

export interface SearchState {
  open: boolean;
  query: string;
  scope: SearchScope;
  // Changes on every submit, so the same query can be run again.
  run: number;
}

let state: SearchState = {
  open: false,
  query: "",
  scope: "agents",
  run: 0,
};
const listeners = new Set<() => void>();

function set(next: Partial<SearchState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function openSearch(query: string, scope: SearchScope): void {
  set({ open: true, query, scope, run: state.run + 1 });
}

export function closeSearch(): void {
  if (state.open) set({ open: false });
}

export function getSearchState(): SearchState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSearchState(): SearchState {
  return useSyncExternalStore(subscribe, getSearchState);
}
