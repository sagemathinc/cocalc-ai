/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether the search results page is showing, for which query, and which
// kind of thing comes first (the page the search started from).

import { useSyncExternalStore } from "react";

export type SearchScope = "agents" | "projects" | "artifacts" | "people";

export const SEARCH_SCOPES: SearchScope[] = [
  "agents",
  "projects",
  "artifacts",
  "people",
];

export interface SearchState {
  open: boolean;
  query: string;
  scope: SearchScope;
  // Changes on every submit, so the same query can be run again.
  run: number;
  // The app path to return to (Back or Escape), without the base path.
  returnPath?: string;
  // Set by Back or Escape: put returnPath back in the address bar.
  restoreUrl?: boolean;
  // The page the results cover (an opaque signature from the workspace);
  // navigating away from it closes them. Unset until known, e.g. after
  // loading a /search/... address.
  origin?: string;
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

export function openSearch(
  query: string,
  scope: SearchScope,
  { returnPath, origin }: { returnPath?: string; origin?: string } = {},
): void {
  set({
    open: true,
    query,
    scope,
    run: state.run + 1,
    returnPath: returnPath ?? state.returnPath,
    restoreUrl: false,
    origin,
  });
}

export function setSearchOrigin(origin: string): void {
  if (state.open) set({ origin });
}

// Leave the results. Back/Escape (`restoreUrl`) returns the address bar to
// the page underneath; opening a result navigates, which sets its own.
export function closeSearch({
  restoreUrl = false,
}: { restoreUrl?: boolean } = {}): void {
  if (state.open) set({ open: false, restoreUrl });
}

// The results page's address: /search/<scope>/<query>.
export function searchPath(scope: SearchScope, query: string): string {
  return `search/${scope}/${encodeURIComponent(query)}`;
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
