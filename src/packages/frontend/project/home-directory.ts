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
  return normalizeHome(
    store.getIn?.([
      "configuration",
      "main",
      "capabilities",
      "homeDirectory",
    ]) as any,
  );
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
    return resolved;
  }
  // Do not cache fallback so a later capabilities update can populate cache.
  return LITE_FALLBACK_HOME;
}
