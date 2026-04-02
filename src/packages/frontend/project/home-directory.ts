import { redux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";

const FALLBACK_HOME = "/";
const HOME_CACHE = new Map<string, string>();
const USER_CACHE = new Map<string, string>();

function normalizeHome(home: string | undefined): string | undefined {
  if (typeof home !== "string" || home.length === 0) return;
  return normalizeAbsolutePath(home);
}

function normalizeUser(user: string | undefined): string | undefined {
  if (typeof user !== "string") return;
  const trimmed = user.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getProjectStore(projectId?: string): any {
  if (!projectId) return;
  return redux.getProjectStore(projectId);
}

function readExactHomeFromStore(store: any): string | undefined {
  if (!store) return;
  const features = store.get("available_features") as any;
  const fromFeatures = normalizeHome(
    features?.get?.("homeDirectory") ?? features?.homeDirectory,
  );
  if (fromFeatures) return fromFeatures;
  const fromConfiguration = normalizeHome(
    store.getIn?.([
      "configuration",
      "main",
      "capabilities",
      "homeDirectory",
    ]) as any,
  );
  if (fromConfiguration) return fromConfiguration;
}

function readExactHomeFromProjectStore(projectId?: string): string | undefined {
  return readExactHomeFromStore(getProjectStore(projectId));
}

function readHomeFromProjectStore(projectId?: string): string | undefined {
  const store = getProjectStore(projectId);
  if (!store) return;
  const exact = readExactHomeFromStore(store);
  if (exact) return exact;
  const candidatePaths = [
    store.get("current_path_abs"),
    store.get("explorer_browsing_path_abs"),
    store.get("flyout_browsing_path_abs"),
    ...(store.get("open_files_order")?.toArray?.() ?? []),
  ];
  for (const candidate of candidatePaths) {
    const normalizedCandidate = normalizeHome(candidate);
    if (!normalizedCandidate || normalizedCandidate === "/") continue;
    if (
      normalizedCandidate === "/root" ||
      normalizedCandidate.startsWith("/root/")
    ) {
      return "/root";
    }
    const homeMatch = normalizedCandidate.match(/^\/home\/[^/]+/);
    if (homeMatch) {
      return homeMatch[0];
    }
  }
}

function readRuntimeUserFromProjectStore(
  projectId?: string,
): string | undefined {
  if (!projectId) return;
  const store = redux.getProjectStore(projectId);
  if (!store) return;
  const features = store.get("available_features") as any;
  const fromFeatures = normalizeUser(
    features?.get?.("runtimeUser") ?? features?.runtimeUser,
  );
  if (fromFeatures) return fromFeatures;
  return normalizeUser(
    store.getIn?.([
      "configuration",
      "main",
      "capabilities",
      "runtimeUser",
    ]) as any,
  );
}

// Frontend canonical HOME for path normalization. This now always prefers
// runtime capabilities instead of assuming launchpad projects use /root.
export function getProjectHomeDirectory(projectId?: string): string {
  const cacheKey = projectId ?? "__default__";
  const cached = HOME_CACHE.get(cacheKey);
  if (cached) return cached;
  const resolved = readHomeFromProjectStore(projectId);
  if (resolved) {
    HOME_CACHE.set(cacheKey, resolved);
    HOME_CACHE.set("__default__", resolved);
    return resolved;
  }
  if (cacheKey !== "__default__") {
    const fallbackCached = HOME_CACHE.get("__default__");
    if (fallbackCached) return fallbackCached;
  }
  // Do not cache fallback so a later capabilities update can populate cache.
  return FALLBACK_HOME;
}

export function getProjectRuntimeUser(projectId?: string): string {
  const cacheKey = projectId ?? "__default__";
  const cached = USER_CACHE.get(cacheKey);
  if (cached) return cached;
  const resolved = readRuntimeUserFromProjectStore(projectId);
  if (resolved) {
    USER_CACHE.set(cacheKey, resolved);
    USER_CACHE.set("__default__", resolved);
    return resolved;
  }
  const home = getProjectHomeDirectory(projectId);
  if (home.startsWith("/home/")) {
    return (
      home.slice("/home/".length).split("/")[0] || DEFAULT_PROJECT_RUNTIME_USER
    );
  }
  if (home === "/root" || home.startsWith("/root/")) {
    return "root";
  }
  if (cacheKey !== "__default__") {
    const fallbackCached = USER_CACHE.get("__default__");
    if (fallbackCached) return fallbackCached;
  }
  if (home === DEFAULT_PROJECT_RUNTIME_HOME) {
    return DEFAULT_PROJECT_RUNTIME_USER;
  }
  return DEFAULT_PROJECT_RUNTIME_USER;
}

function setCachedHome(projectId: string | undefined, home: string): string {
  const cacheKey = projectId ?? "__default__";
  HOME_CACHE.set(cacheKey, home);
  HOME_CACHE.set("__default__", home);
  return home;
}

export async function resolveProjectHomeDirectory(
  projectId?: string,
): Promise<string> {
  const exactFromStore = readExactHomeFromProjectStore(projectId);
  if (exactFromStore) {
    return setCachedHome(projectId, exactFromStore);
  }
  if (!lite || !projectId) {
    return getProjectHomeDirectory(projectId);
  }
  try {
    const config = await webapp_client.project_client.configuration(
      projectId,
      "main",
      false,
    );
    const fromConfig = normalizeHome(
      (config as any)?.capabilities?.homeDirectory,
    );
    if (fromConfig) {
      return setCachedHome(projectId, fromConfig);
    }
  } catch {
    // best effort only
  }
  const heuristicFromStore = readHomeFromProjectStore(projectId);
  if (heuristicFromStore) {
    return setCachedHome(projectId, heuristicFromStore);
  }
  return getProjectHomeDirectory(projectId);
}
