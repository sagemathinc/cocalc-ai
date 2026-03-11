const ROUTE_MARKERS = [
  "/projects/",
  "/settings",
  "/preferences",
  "/notifications",
  "/admin",
  "/hosts",
  "/auth",
  "/ssh",
  "/support",
  "/store",
  "/software",
  "/terminal",
];

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

  for (const marker of ROUTE_MARKERS) {
    const index = normalizedPathname.indexOf(marker);
    if (index !== -1) {
      return index === 0 ? "/" : normalizedPathname.slice(0, index);
    }
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
