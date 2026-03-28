/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectFixedRouteTab =
  | "agents"
  | "info"
  | "log"
  | "project-home"
  | "servers"
  | "settings"
  | "users"
  | "workspaces";

export type ParsedProjectTarget =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; parentPath: string }
  | { kind: "new"; path: string }
  | { kind: "search"; path: string }
  | { kind: "tab"; tab: ProjectFixedRouteTab }
  | { kind: "app"; path: string };

type PathEncoder = {
  encodeRelativePath: (path: string) => string;
};

type PathDecoder = {
  decodeDirectoryPath: (path: string) => string;
};

export function buildProjectFilesTarget(
  path: string,
  isDirectory: boolean,
  opts: PathEncoder,
): string {
  const relativePath = opts.encodeRelativePath(path);
  if (relativePath.length === 0) {
    return "files/";
  }
  return `files/${relativePath}${isDirectory ? "/" : ""}`;
}

export function buildProjectScopedTarget(
  tab: "new" | "search",
  path: string,
  opts: PathEncoder,
): string {
  const relativePath = opts.encodeRelativePath(path);
  return relativePath.length === 0 ? `${tab}/` : `${tab}/${relativePath}`;
}

export function parseProjectTarget(
  target: string,
  opts: PathDecoder,
): ParsedProjectTarget | undefined {
  const segments = target.split("/");
  const mainSegment = segments[0];
  const hasScopedPathSource =
    (mainSegment === "new" || mainSegment === "search") &&
    segments[1] === "files";
  const scopedPathIndex = hasScopedPathSource ? 2 : 1;

  switch (mainSegment) {
    case "files": {
      const fullPath = opts.decodeDirectoryPath(segments.slice(1).join("/"));
      const parentPath = opts.decodeDirectoryPath(
        segments.slice(1, segments.length - 1).join("/"),
      );
      if (target.endsWith("/")) {
        return { kind: "directory", path: parentPath };
      }
      return { kind: "file", path: fullPath, parentPath };
    }

    case "new":
      return {
        kind: "new",
        path: opts.decodeDirectoryPath(
          segments.slice(scopedPathIndex).join("/"),
        ),
      };

    case "search":
      return {
        kind: "search",
        path: opts.decodeDirectoryPath(
          segments.slice(scopedPathIndex).join("/"),
        ),
      };

    case "agents":
    case "info":
    case "log":
    case "project-home":
    case "servers":
    case "settings":
    case "users":
    case "workspaces":
      return { kind: "tab", tab: mainSegment };

    case "apps":
      return {
        kind: "app",
        path: segments.slice(1).join("/"),
      };

    default:
      return undefined;
  }
}
