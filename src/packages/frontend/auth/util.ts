import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { AuthView } from "./types";

export function appUrl(path: string): string {
  const base = appBasePath.endsWith("/")
    ? appBasePath.slice(0, -1)
    : appBasePath;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${normalizedPath}`;
}

function appRelativePath(pathname: string): string {
  if (
    appBasePath !== "/" &&
    (pathname === appBasePath || pathname.startsWith(`${appBasePath}/`))
  ) {
    return pathname.slice(appBasePath.length) || "/";
  }
  return pathname;
}

export function getSafeAuthRedirectTargetFromSearch(
  search: string = window.location.search,
  depth = 0,
): string | undefined {
  const target = new URLSearchParams(search).get("target");
  if (!target || !target.startsWith("/") || target.startsWith("//")) {
    return undefined;
  }
  try {
    const url = new URL(target, "https://example.invalid");
    if (url.origin !== "https://example.invalid") {
      return undefined;
    }
    const relative = appRelativePath(url.pathname);
    if (relative === "/") {
      return undefined;
    }
    if (/^\/(auth|sso)(\/|$)/.test(relative)) {
      return depth < 3
        ? getSafeAuthRedirectTargetFromSearch(url.search, depth + 1)
        : undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function signedInRedirectUrl(
  search: string = window.location.search,
): string {
  return getSafeAuthRedirectTargetFromSearch(search) ?? appUrl("projects");
}

export function authViewUrl(
  view: AuthView,
  search: string = window.location.search,
): string {
  const url = appUrl(`auth/${view}`);
  const target = getSafeAuthRedirectTargetFromSearch(search);
  if (!target) {
    return url;
  }
  return `${url}?target=${encodeURIComponent(target)}`;
}
