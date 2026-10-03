/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The text in the search boxes (the sidebar's, and the one at the top of
// the Agents, Projects, Artifacts and People pages): one value, so typing
// in either narrows both the sidebar list and the page's list or grid.
// Each page starts with an empty box.

import { useSyncExternalStore } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { openSearch, type SearchScope } from "./search-store";

let value = "";
const listeners = new Set<() => void>();

export function setListQuery(next: string): void {
  if (next === value) return;
  value = next;
  for (const listener of listeners) listener();
}

export function getListQuery(): string {
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useListQuery(): string {
  return useSyncExternalStore(subscribe, getListQuery);
}

// Enter in a search box: the results page, returning to this address.
export function submitSearch(
  query: string,
  scope: SearchScope,
  // The workspace's signature of the page underneath, when known.
  origin?: string,
): void {
  const base = appBasePath === "/" ? "" : appBasePath;
  const here = location.pathname.slice(base.length).replace(/^\/+/, "");
  openSearch(
    query,
    scope,
    here.startsWith("search/") ? { origin } : { returnPath: here, origin },
  );
}
