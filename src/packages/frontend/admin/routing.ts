/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type AdminRoute =
  | { kind: "index" }
  | { kind: "news-list" }
  | { kind: "news-editor"; id: string };

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

export function getAdminTargetPath(route: AdminRoute): string {
  switch (route.kind) {
    case "index":
      return "admin";
    case "news-list":
      return "admin/news";
    case "news-editor":
      return `admin/news/${route.id}`;
  }
}

export function getAdminUrlPath(route: AdminRoute): string {
  return `/${getAdminTargetPath(route)}`;
}
