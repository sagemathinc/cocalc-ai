// All top level page "entry points" in the webapp must be listed here.
// Should be consistent with and/or used in places like:
//   - @cocalc/frontend/history.ts
//   - @cocalc/frontend/app/actions.ts
//   - @cocalc/hub/servers/app/app-redirect.ts

export const APP_ROUTES = new Set([
  "admin",
  "file-use",
  "help",
  "ssh",
  "projects",
  "settings",
  "notifications",
  "hosts",
]);

const HOST_ROOT_ONLY_ROUTES = [
  "about",
  "account",
  "auth",
  "billing",
  "blobs",
  "register",
  "software",
] as const;

export const HOST_ABSOLUTE_ROUTE_PREFIXES: readonly string[] = Array.from(
  new Set([
    "/projects",
    ...Array.from(APP_ROUTES)
      .filter((route) => route !== "projects")
      .map((route) => `/${route}`),
    ...HOST_ROOT_ONLY_ROUTES.map((route) => `/${route}`),
  ]),
);

export function hasHostAbsoluteRoutePrefix(path?: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return false;
  }
  return HOST_ABSOLUTE_ROUTE_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.startsWith(`${prefix}?`),
  );
}

// Shared route markers for places that need to infer the app root from a live
// browser pathname. Project subroutes are covered by "/projects/", so
// project-internal pages such as "/projects/<id>/apps" and
// "/projects/<id>/project-home" do not belong in APP_ROUTES and do not require
// updates here. Auth is kept separate because it is routed through the SPA
// only in selected server contexts.
export const APP_BASE_PATH_ROUTE_MARKERS: readonly string[] = [
  "/projects/",
  ...HOST_ABSOLUTE_ROUTE_PREFIXES.filter((prefix) => prefix !== "/projects"),
];
