/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseCommitHash } from "@cocalc/frontend/chat/git-commit/commit-selection";

export const GIT_REVIEW_ROUTE_PARAMS = ["git-hash", "git-cwd"] as const;
export const APP_NAVIGATION_EVENT = "cocalc:app-navigation";

export interface GitReviewRoute {
  commit: string;
  cwd?: string;
}

let lastBrowserLocation: URL | undefined;

export function consumeGitReviewOnlyNavigation(next: URL): boolean {
  const previous = lastBrowserLocation;
  lastBrowserLocation = new URL(next);
  return (
    previous != null &&
    previous.href !== next.href &&
    setGitReviewRoute(previous).href === setGitReviewRoute(next).href
  );
}

export function ownsGitReviewRoute(
  url: URL,
  projectId: string,
  path: string,
): boolean {
  try {
    const match = decodeURIComponent(url.pathname).match(
      /(?:^|\/)projects\/([^/]+)\/files\/(.*)$/,
    );
    return match?.[1] === projectId && match?.[2] === path.replace(/^\/+/, "");
  } catch {
    return false;
  }
}

export function readGitReviewRoute(url: URL): GitReviewRoute | undefined {
  const commit = parseCommitHash(url.searchParams.get("git-hash") ?? undefined);
  const cwd = url.searchParams.get("git-cwd") ?? undefined;
  // Only object IDs and the explicitly named working state, never Git options
  // or arbitrary revision expressions. Repository resolution remains separate.
  if (!commit) return;
  if (cwd != null && (!cwd || cwd.length > 8192 || cwd.includes("\0"))) return;
  return { commit, cwd };
}

export function setGitReviewRoute(url: URL, route?: GitReviewRoute): URL {
  const next = new URL(url);
  for (const key of GIT_REVIEW_ROUTE_PARAMS) next.searchParams.delete(key);
  if (route) {
    next.searchParams.set("git-hash", route.commit);
    if (route.cwd != null) next.searchParams.set("git-cwd", route.cwd);
  }
  return next;
}

// Query parameters normally survive app navigation, but these identify one
// file's drawer. Explicit searches supplied by a caller are not filtered here.
export function gitReviewSearchForNavigation(
  current: URL,
  pathname: string,
): string {
  return current.pathname === pathname
    ? current.search
    : setGitReviewRoute(current).search;
}

export function createGitReviewNavigationSearch(initial: URL) {
  let pending = readGitReviewRoute(initial);
  const filesIndex = initial.pathname.indexOf("/files/");
  const filesRoot =
    filesIndex < 0 ? undefined : initial.pathname.slice(0, filesIndex + 7);
  return (current: URL, pathname: string): string => {
    // Opening a project first writes its directory URL, then the requested
    // editor URL. Retain the landing review only across that bootstrap, never
    // apply it to a different editor or restore it again after dismissal.
    if (pending) {
      if (pathname === initial.pathname) {
        const route = pending;
        pending = undefined;
        return setGitReviewRoute(current, route).search;
      }
      if (
        !filesRoot ||
        !pathname.startsWith(filesRoot) ||
        !pathname.endsWith("/")
      ) {
        pending = undefined;
      }
    }
    return gitReviewSearchForNavigation(current, pathname);
  };
}

export function writeGitReviewRoute(
  projectId: string,
  path: string,
  route?: GitReviewRoute,
  push = false,
): void {
  const current = new URL(window.location.href);
  if (!ownsGitReviewRoute(current, projectId, path)) return;
  const next = setGitReviewRoute(current, route);
  lastBrowserLocation = new URL(next);
  if (next.href === current.href) return;
  // The owning React component already updates its state. Only real app
  // navigation/popstate notifies listeners, avoiding a write/read feedback loop.
  window.history[push ? "pushState" : "replaceState"](
    window.history.state,
    "",
    next.href,
  );
}
