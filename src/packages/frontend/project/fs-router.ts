import { normalizeAbsolutePath } from "@cocalc/util/path-model";

export type FsServiceKind = "backend_home" | "project_runtime";

export interface FsRoutingContext {
  lite: boolean;
  projectRunning: boolean;
  homeDirectory: string;
}

export type FsRoutingReason =
  | "lite-mode"
  | "launchpad-stopped-home"
  | "launchpad-running-home"
  | "launchpad-running-non-home";

export interface FsRouteDecision {
  kind: FsServiceKind;
  reason: FsRoutingReason;
  normalizedPath: string;
  normalizedHome: string;
}

export function isPathInHome(path: string, homeDirectory: string): boolean {
  const normalizedHome = normalizeAbsolutePath(homeDirectory || "/");
  const normalizedPath = normalizeAbsolutePath(path, normalizedHome);
  if (normalizedHome === "/") {
    return true;
  }
  return (
    normalizedPath === normalizedHome ||
    normalizedPath.startsWith(`${normalizedHome}/`)
  );
}

export function selectFsService(
  path: string,
  context: FsRoutingContext,
): FsRouteDecision {
  const normalizedHome = normalizeAbsolutePath(context.homeDirectory || "/");
  const normalizedPath = normalizeAbsolutePath(path || "/", normalizedHome);

  if (context.lite) {
    return {
      kind: "project_runtime",
      reason: "lite-mode",
      normalizedPath,
      normalizedHome,
    };
  }

  if (!context.projectRunning) {
    return {
      kind: "backend_home",
      reason: "launchpad-stopped-home",
      normalizedPath,
      normalizedHome,
    };
  }

  if (isPathInHome(normalizedPath, normalizedHome)) {
    return {
      kind: "backend_home",
      reason: "launchpad-running-home",
      normalizedPath,
      normalizedHome,
    };
  }

  return {
    kind: "project_runtime",
    reason: "launchpad-running-non-home",
    normalizedPath,
    normalizedHome,
  };
}

