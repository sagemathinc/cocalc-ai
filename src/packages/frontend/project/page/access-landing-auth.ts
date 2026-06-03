/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function shouldFetchProjectAccessLandingInfo({
  isActive,
  accountIsReady,
  isLoggedIn,
  hasProject,
  liteMode = false,
}: {
  isActive: boolean;
  accountIsReady: boolean;
  isLoggedIn: boolean;
  hasProject: boolean;
  liteMode?: boolean;
}): boolean {
  return !liteMode && isActive && accountIsReady && isLoggedIn && !hasProject;
}

export function hasProjectRoleForAccessLandingBypass({
  accountId,
  project,
  isAdmin = false,
  liteMode = false,
}: {
  accountId?: string | null;
  project: any;
  isAdmin?: boolean;
  liteMode?: boolean;
}): boolean {
  if (liteMode) return true;
  if (project == null) return false;
  if (isAdmin) return true;
  if (!accountId) return false;
  const group = project.getIn?.(["users", accountId, "group"]);
  return group === "owner" || group === "collaborator" || group === "viewer";
}

export function projectAccessSignInHref({
  pathname,
  search = "",
  hash = "",
}: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  const target = `${pathname}${search}${hash}`;
  if (!target || target === "/" || target.startsWith("/auth/")) {
    return "/auth/sign-in";
  }
  return `/auth/sign-in?target=${encodeURIComponent(target)}`;
}

export function projectAccessSignInHrefForCurrentLocation(): string {
  if (typeof window === "undefined") {
    return "/auth/sign-in";
  }
  return projectAccessSignInHref({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
}
