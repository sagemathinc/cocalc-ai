import { APP_BASE_PATH_ROUTE_MARKERS } from "@cocalc/util/routing/app";
import { LOCALE } from "@cocalc/util/i18n/locale";

const UUID_PATTERN =
  /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

function isUUID(uuid: string): boolean {
  return UUID_PATTERN.test(uuid);
}

function inferProjectHostBasePath(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const uuidIndex = parts.findIndex(isUUID);
  if (uuidIndex === -1) {
    return;
  }
  return uuidIndex === 0 ? "/" : `/${parts.slice(0, uuidIndex).join("/")}`;
}

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

  // A project-host URL can contain app route names inside its file path, e.g.
  // /<project-id>/files/home/user/a.pdf. Search only before the project id.
  const projectHostBasePath = inferProjectHostBasePath(normalizedPathname);
  const routePathname = projectHostBasePath ?? normalizedPathname;
  for (const marker of APP_BASE_PATH_ROUTE_MARKERS) {
    let index = routePathname.indexOf(marker);
    while (index !== -1) {
      const after = routePathname.slice(index + marker.length);
      // Short personal-address routes such as /u must not match a longer
      // directory name.
      if (!after || after.startsWith("/")) {
        return index === 0 ? "/" : normalizedPathname.slice(0, index);
      }
      index = routePathname.indexOf(marker, index + marker.length);
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

  if (projectHostBasePath != null) {
    return projectHostBasePath;
  }

  const trimmed =
    normalizedPathname.length > 1
      ? normalizedPathname.replace(/\/+$/, "")
      : normalizedPathname;
  return trimmed || "/";
}

// When the hub serves the public shell at a clean URL (e.g. /docs/a/b), it
// injects <meta name="cocalc-base-path" content="<basePath>"> into the head.
// That is the authoritative serve-time base path signal, so prefer it over
// inferring from the pathname.
export function inferBasePathFromMetaElement(): string | undefined {
  if (typeof document === "undefined") return;
  const content = document
    .querySelector('meta[name="cocalc-base-path"]')
    ?.getAttribute("content")
    ?.trim();
  if (!content || !content.startsWith("/")) return;
  return content.length > 1 ? content.replace(/\/+$/, "") : content;
}

// Legacy shells stated the base path via <base href="<basePath>/static/">
// instead of the meta tag.
// TODO remove once all deployed hubs inject the cocalc-base-path meta tag.
export function inferBasePathFromBaseElement(): string | undefined {
  if (typeof document === "undefined") return;
  const href = document.querySelector("base")?.getAttribute("href");
  if (!href) return;
  let pathname: string;
  try {
    pathname = new URL(href, window.location.href).pathname;
  } catch {
    return;
  }
  const suffix = "/static/";
  if (!pathname.endsWith(suffix)) return;
  return pathname.slice(0, -suffix.length) || "/";
}

function init(): string {
  if (process.env.BASE_PATH) {
    // This is used by next.js.
    return process.env.BASE_PATH;
  }
  if (typeof window != "undefined" && typeof window.location != "undefined") {
    const fromMetaElement = inferBasePathFromMetaElement();
    if (fromMetaElement != null) {
      return fromMetaElement;
    }
    const fromBaseElement = inferBasePathFromBaseElement();
    if (fromBaseElement != null) {
      return fromBaseElement;
    }
    // For static frontend we determine the base path from the current route.
    return inferAppBasePath(window.location.pathname);
  }
  return "/";
}

export let appBasePath: string = init();
