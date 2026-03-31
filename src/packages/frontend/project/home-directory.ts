import { redux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

const NON_LITE_HOME = "/root";
const LITE_FALLBACK_HOME = "/";
const HOME_CACHE = new Map<string, string>();

function normalizeHome(home: string | undefined): string | undefined {
  if (typeof home !== "string" || home.length === 0) return;
  return normalizeAbsolutePath(home);
}

function readHomeFromProjectStore(projectId?: string): string | undefined {
  if (!projectId) return;
  const store = redux.getProjectStore(projectId);
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

// Frontend canonical HOME for path normalization.
// Launchpad/non-lite always uses /root. Lite reads from project capabilities.
export function getProjectHomeDirectory(projectId?: string): string {
  if (!lite) return NON_LITE_HOME;
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
  return LITE_FALLBACK_HOME;
}
