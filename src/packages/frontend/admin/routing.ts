/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type AdminRoute =
  | { kind: "index" }
  | { kind: "news-list" }
  | { kind: "news-editor"; id: string };

type AdminRouteLike =
  | AdminRoute
  | {
      get?: (key: string) => unknown;
      toJS?: () => unknown;
    }
  | null
  | undefined;

export function parseAdminRoute(
  input: string | readonly string[],
): AdminRoute | undefined {
  const rawSegments =
    typeof input === "string" ? input.split("/") : Array.from(input);
  const segments = rawSegments.filter(Boolean);
  if (segments[0] === "admin") {
    segments.shift();
  }
  const [section, id] = segments;

  switch (section) {
    case undefined:
    case "":
      return { kind: "index" };
    case "news":
      if (!id) {
        return { kind: "news-list" };
      }
      return { kind: "news-editor", id };
    default:
      return undefined;
  }
}

export function normalizeAdminRoute(route: AdminRouteLike): AdminRoute {
  if (route == null) {
    return { kind: "index" };
  }
  let normalized: unknown = route;
  const routeObject = route as {
    get?: (key: string) => unknown;
    toJS?: () => unknown;
  };
  if (typeof routeObject.toJS === "function") {
    normalized = routeObject.toJS();
  } else if (typeof routeObject.get === "function") {
    normalized = {
      kind: routeObject.get("kind"),
      id: routeObject.get("id"),
    };
  }

  switch (normalized?.["kind"]) {
    case "news-list":
      return { kind: "news-list" };
    case "news-editor": {
      const id = normalized?.["id"];
      if (typeof id === "string" && id) {
        return { kind: "news-editor", id };
      }
      return { kind: "news-list" };
    }
    case "index":
    default:
      return { kind: "index" };
  }
}

export function getAdminTargetPath(route: AdminRouteLike): string {
  const normalized = normalizeAdminRoute(route);
  switch (normalized.kind) {
    case "index":
      return "admin";
    case "news-list":
      return "admin/news";
    case "news-editor":
      return `admin/news/${normalized.id}`;
  }
}

export function getAdminUrlPath(route: AdminRouteLike): string {
  return `/${getAdminTargetPath(route)}`;
}
