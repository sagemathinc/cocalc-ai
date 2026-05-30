/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function shouldFetchProjectAccessLandingInfo({
  isActive,
  accountIsReady,
  isLoggedIn,
  hasProject,
  hasOpenFilesOrder,
}: {
  isActive: boolean;
  accountIsReady: boolean;
  isLoggedIn: boolean;
  hasProject: boolean;
  hasOpenFilesOrder: boolean;
}): boolean {
  return (
    isActive &&
    accountIsReady &&
    isLoggedIn &&
    !hasProject &&
    !hasOpenFilesOrder
  );
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
