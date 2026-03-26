import { APP_BASE_PATH_ROUTE_MARKERS } from "@cocalc/util/routing/app";
import { LOCALE } from "@cocalc/util/i18n";

function inferLangBasePath(pathname: string): string | undefined {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/lang") {
    return "/";
  }
  const marker = "/lang/";
  const index = normalized.indexOf(marker);
  if (index !== -1) {
    return index === 0 ? "/" : normalized.slice(0, index);
  }
}

function inferLocaleAliasBasePath(pathname: string): string | undefined {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const locale of LOCALE) {
    const marker = `/${locale}`;
    if (normalized === marker) {
      return "/";
    }
    if (normalized.endsWith(marker)) {
      const prefix = normalized.slice(0, -marker.length);
      if (prefix.startsWith("/")) {
        return prefix || "/";
      }
    }
  }
}

export function inferAppBasePath(pathname?: string): string {
  const normalizedPathname = `${pathname ?? ""}`.trim();
  if (!normalizedPathname || normalizedPathname === "/") {
    return "/";
  }

  // Static asset URLs already include the real base path immediately before
  // "/static", so prefer that exact signal when available.
  const staticIndex = normalizedPathname.lastIndexOf("/static");
  if (staticIndex !== -1) {
    return staticIndex === 0 ? "/" : normalizedPathname.slice(0, staticIndex);
  }

  for (const marker of APP_BASE_PATH_ROUTE_MARKERS) {
    const index = normalizedPathname.indexOf(marker);
    if (index !== -1) {
      return index === 0 ? "/" : normalizedPathname.slice(0, index);
    }
  }

  const langBasePath = inferLangBasePath(normalizedPathname);
  if (langBasePath != null) {
    return langBasePath;
  }

  const localeBasePath = inferLocaleAliasBasePath(normalizedPathname);
  if (localeBasePath != null) {
    return localeBasePath;
  }

  const trimmed =
    normalizedPathname.length > 1
      ? normalizedPathname.replace(/\/+$/, "")
      : normalizedPathname;
  return trimmed || "/";
}

function init(): string {
  if (process.env.BASE_PATH) {
    // This is used by next.js.
    return process.env.BASE_PATH;
  }
  if (typeof window != "undefined" && typeof window.location != "undefined") {
    // For static frontend we determine the base path from the current route.
    return inferAppBasePath(window.location.pathname);
  }
  return "/";
}

export let appBasePath: string = init();
