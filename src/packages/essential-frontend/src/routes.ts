/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getAppBasePath, siteUrl } from "./urls";

export type UltraliteRoute =
  | { kind: "projects" }
  | { kind: "notifications" }
  | { kind: "files"; projectId: string; path: string }
  | { kind: "file"; projectId: string; path: string }
  | { kind: "recent"; projectId: string }
  | { kind: "agents"; projectId: string }
  | { kind: "notebooks"; projectId: string }
  | { kind: "terminal"; projectId: string }
  | { kind: "vms"; projectId: string }
  | { kind: "apps"; projectId: string }
  | { kind: "cli"; projectId: string }
  | { kind: "settings"; projectId: string }
  | {
      kind: "chat";
      projectId: string;
      chatPath: string;
      threadId: string;
    };

export const ULTRALITE_BEFORE_NAVIGATE = "cocalc-ultralite-before-navigate";
export const ESSENTIAL_ROUTE_CHANGE = "cocalc-essential-route-change";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EssentialRouteLocation {
  hash?: string;
  pathname: string;
  search?: string;
}

export function normalizeProjectPath(value?: string): string {
  const parts = `${value || "/home/user"}`
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") normalized.pop();
    else if (!part.includes("\0")) normalized.push(part);
  }
  const path = `/${normalized.join("/")}`;
  return path === "/home/user" || path.startsWith("/home/user/")
    ? path
    : "/home/user";
}

function parseLegacyHash(hash: string): UltraliteRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [pathname, query = ""] = raw.split("?", 2);
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "notifications") return { kind: "notifications" };
  if (segments[0] !== "project" || !UUID.test(segments[1] ?? "")) {
    return { kind: "projects" };
  }
  const projectId = segments[1];
  const params = new URLSearchParams(query);
  switch (segments[2]) {
    case "files":
      return {
        kind: "files",
        projectId,
        path: normalizeProjectPath(params.get("path") ?? undefined),
      };
    case "file":
      return {
        kind: "file",
        projectId,
        path: normalizeProjectPath(params.get("path") ?? undefined),
      };
    case "recent":
      return { kind: "recent", projectId };
    case "agents":
      return { kind: "agents", projectId };
    case "notebooks":
      return { kind: "notebooks", projectId };
    case "terminal":
      return { kind: "terminal", projectId };
    case "vms":
      return { kind: "vms", projectId };
    case "apps":
      return { kind: "apps", projectId };
    case "cli":
      return { kind: "cli", projectId };
    case "settings":
      return { kind: "settings", projectId };
    case "chat": {
      const chatPath = normalizeProjectPath(params.get("path") ?? undefined);
      const threadId = params.get("thread")?.trim();
      return threadId
        ? { kind: "chat", projectId, chatPath, threadId }
        : { kind: "agents", projectId };
    }
    default:
      return { kind: "files", projectId, path: "/home/user" };
  }
}

function decodeSegments(values: string[]): string[] | undefined {
  try {
    return values.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

export function parseEssentialRoute(
  location: EssentialRouteLocation,
): UltraliteRoute | undefined {
  const marker = /\/essential(?:\/|$)/.exec(location.pathname);
  if (!marker) return;
  const raw = location.pathname.slice(marker.index + marker[0].length);
  const segments = decodeSegments(raw.split("/").filter(Boolean));
  if (!segments) return { kind: "projects" };
  if (!segments.length || (segments[0] === "projects" && !segments[1])) {
    return { kind: "projects" };
  }
  if (segments[0] === "notifications") return { kind: "notifications" };
  if (segments[0] !== "projects" || !UUID.test(segments[1] ?? "")) {
    return { kind: "projects" };
  }
  const projectId = segments[1];
  const surface = segments[2];
  switch (surface) {
    case "files": {
      const path = normalizeProjectPath(`/${segments.slice(3).join("/")}`);
      const directory =
        segments.length === 3 || location.pathname.endsWith("/");
      return { kind: directory ? "files" : "file", projectId, path };
    }
    case "recent":
      return { kind: "recent", projectId };
    case "codex": {
      if (segments[3] !== "chat") return { kind: "agents", projectId };
      const params = new URLSearchParams(location.search ?? "");
      const chatPath = normalizeProjectPath(params.get("path") ?? undefined);
      const threadId = params.get("thread")?.trim();
      return threadId
        ? { kind: "chat", projectId, chatPath, threadId }
        : { kind: "agents", projectId };
    }
    case "jupyter":
      return { kind: "notebooks", projectId };
    case "terminal":
      return { kind: "terminal", projectId };
    case "vms":
      return { kind: "vms", projectId };
    case "apps":
      return { kind: "apps", projectId };
    case "cli":
      return { kind: "cli", projectId };
    case "settings":
      return { kind: "settings", projectId };
    default:
      return { kind: "files", projectId, path: "/home/user" };
  }
}

export function parseRoute(
  input?: string | EssentialRouteLocation,
): UltraliteRoute {
  if (typeof input === "string") return parseLegacyHash(input);
  const location = input ?? window.location;
  return (
    parseEssentialRoute(location) ??
    (location.hash ? parseLegacyHash(location.hash) : { kind: "projects" })
  );
}

// Retained for compatibility tests and old external links. New navigation uses
// essentialRouteUrl and the History API.
export function routeHash(route: UltraliteRoute): string {
  if (route.kind === "projects") return "#/projects";
  if (route.kind === "notifications") return "#/notifications";
  const root = `#/project/${route.projectId}`;
  switch (route.kind) {
    case "files":
      return `${root}/files?${new URLSearchParams({ path: route.path })}`;
    case "file":
      return `${root}/file?${new URLSearchParams({ path: route.path })}`;
    case "recent":
      return `${root}/recent`;
    case "agents":
      return `${root}/agents`;
    case "notebooks":
      return `${root}/notebooks`;
    case "terminal":
      return `${root}/terminal`;
    case "vms":
      return `${root}/vms`;
    case "apps":
      return `${root}/apps`;
    case "cli":
      return `${root}/cli`;
    case "settings":
      return `${root}/settings`;
    case "chat":
      return `${root}/chat?${new URLSearchParams({
        path: route.chatPath,
        thread: route.threadId,
      })}`;
  }
}

function encodeProjectPath(path: string): string {
  return normalizeProjectPath(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function essentialRouteUrl(
  route: UltraliteRoute,
  basePath = getAppBasePath(),
): string {
  const root = siteUrl("essential", basePath);
  if (route.kind === "projects") return `${root}/projects`;
  if (route.kind === "notifications") return `${root}/notifications`;
  const projectRoot = `${root}/projects/${route.projectId}`;
  switch (route.kind) {
    case "files":
      return `${projectRoot}/files/${encodeProjectPath(route.path)}/`;
    case "file":
      return `${projectRoot}/files/${encodeProjectPath(route.path)}`;
    case "recent":
      return `${projectRoot}/recent`;
    case "agents":
      return `${projectRoot}/codex`;
    case "notebooks":
      return `${projectRoot}/jupyter`;
    case "terminal":
      return `${projectRoot}/terminal`;
    case "vms":
      return `${projectRoot}/vms`;
    case "apps":
      return `${projectRoot}/apps`;
    case "cli":
      return `${projectRoot}/cli`;
    case "settings":
      return `${projectRoot}/settings`;
    case "chat":
      return `${projectRoot}/codex/chat?${new URLSearchParams({
        path: route.chatPath,
        thread: route.threadId,
      })}`;
  }
}

export function navigate(route: UltraliteRoute): void {
  const event = new CustomEvent(ULTRALITE_BEFORE_NAVIGATE, {
    cancelable: true,
    detail: { route },
  });
  if (!window.dispatchEvent(event)) return;
  const url = essentialRouteUrl(route);
  if (`${window.location.pathname}${window.location.search}` !== url) {
    window.history.pushState({}, "", url);
  }
  window.dispatchEvent(new Event(ESSENTIAL_ROUTE_CHANGE));
}
