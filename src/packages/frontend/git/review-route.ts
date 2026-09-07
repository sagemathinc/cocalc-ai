/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseCommitHash } from "@cocalc/frontend/chat/git-commit/commit-selection";

export const GIT_REVIEW_ROUTE_PARAMS = [
  "git-hash",
  "git-cwd",
  "git-tip",
  "git-ref",
  "git-ancestry",
  "git-compare",
] as const;
export const APP_NAVIGATION_EVENT = "cocalc:app-navigation";

export interface GitReviewRoute {
  commit: string;
  cwd?: string;
  history?: GitReviewHistoryRoute;
  comparison?: GitComparisonRoute;
}

export type GitComparisonRoute = {
  commonDirectory: string;
  head: string;
} & (
  | { mode: "parent"; parentIndex: number }
  | { mode: "trees" | "merge-base"; base: string }
);

export function parseGitComparisonRoute(
  raw: string,
): GitComparisonRoute | undefined {
  if (raw.length > 10000) return;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value.commonDirectory !== "string" ||
      !value.commonDirectory ||
      value.commonDirectory.length > 8192 ||
      value.commonDirectory.includes("\0") ||
      typeof value.head !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head)
    )
      return;
    const scope = { commonDirectory: value.commonDirectory, head: value.head };
    if (
      value.mode === "parent" &&
      Number.isSafeInteger(value.parentIndex) &&
      value.parentIndex >= 0
    ) {
      return { ...scope, mode: "parent", parentIndex: value.parentIndex };
    }
    if (
      (value.mode === "trees" || value.mode === "merge-base") &&
      typeof value.base === "string" &&
      value.base.length === value.head.length &&
      /^[a-f0-9]+$/.test(value.base)
    ) {
      return { ...scope, mode: value.mode, base: value.base };
    }
  } catch {
    return;
  }
}

export interface GitReviewHistoryRoute {
  tip: string;
  ref: string;
  firstParent: boolean;
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
  const rawComparison = url.searchParams.get("git-compare");
  const comparison =
    rawComparison == null ? undefined : parseGitComparisonRoute(rawComparison);
  if (rawComparison != null && !comparison) return;
  const tip = url.searchParams.get("git-tip");
  if (tip == null)
    return { commit, cwd, ...(comparison ? { comparison } : {}) };
  const ref = url.searchParams.get("git-ref") ?? "HEAD";
  const ancestry = url.searchParams.get("git-ancestry") ?? "first-parent";
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(tip) ||
    !ref ||
    ref.length > 8192 ||
    ref.includes("\0") ||
    !["first-parent", "all"].includes(ancestry)
  )
    return;
  return {
    commit,
    cwd,
    ...(comparison ? { comparison } : {}),
    history: {
      tip: tip.toLowerCase(),
      ref,
      firstParent: ancestry === "first-parent",
    },
  };
}

export function setGitReviewRoute(url: URL, route?: GitReviewRoute): URL {
  const next = new URL(url);
  for (const key of GIT_REVIEW_ROUTE_PARAMS) next.searchParams.delete(key);
  if (route) {
    next.searchParams.set("git-hash", route.commit);
    if (route.cwd != null) next.searchParams.set("git-cwd", route.cwd);
    if (route.comparison)
      next.searchParams.set("git-compare", JSON.stringify(route.comparison));
    if (route.history) {
      next.searchParams.set("git-tip", route.history.tip);
      next.searchParams.set("git-ref", route.history.ref);
      next.searchParams.set(
        "git-ancestry",
        route.history.firstParent ? "first-parent" : "all",
      );
    }
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
