/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import { getMountPoint } from "./file-server";

const logger = getLogger("project-host:app-public-access");
export const APP_PUBLIC_TOKEN_QUERY_PARAM = "cocalc_app_token";

interface AppSpec {
  id: string;
  kind: "service" | "static";
  proxy?: { base_path?: string };
}

interface AppExposureState {
  mode?: "private" | "public";
  auth_front?: "none" | "token";
  token?: string;
  expires_at_ms?: number;
}

const CACHE_TTL_MS = 1000;
const cache = new TTL<string, { specs: AppSpec[]; exposures: Record<string, AppExposureState> }>({
  max: 10_000,
  ttl: CACHE_TTL_MS,
});

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function projectAppsDir(project_id: string): string | undefined {
  try {
    return join(
      getMountPoint(),
      `project-${project_id}`,
      ".local",
      "share",
      "cocalc",
      "apps",
    );
  } catch {
    return;
  }
}

async function loadSpecs(project_id: string): Promise<AppSpec[]> {
  const dir = projectAppsDir(project_id);
  if (!dir) return [];
  const fs = await import("node:fs/promises");
  const out: AppSpec[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === "runtime-state.json") continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as AppSpec;
      if (!parsed?.id || !parsed?.proxy?.base_path) continue;
      out.push(parsed);
    } catch {
      // ignore bad files
    }
  }
  return out;
}

async function loadExposures(project_id: string): Promise<Record<string, AppExposureState>> {
  const dir = projectAppsDir(project_id);
  if (!dir) return {};
  const path = join(dir, "runtime-state.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      exposures?: Record<string, AppExposureState>;
    };
    return parsed?.exposures ?? {};
  } catch {
    return {};
  }
}

async function getAppData(project_id: string): Promise<{
  specs: AppSpec[];
  exposures: Record<string, AppExposureState>;
}> {
  const cached = cache.get(project_id);
  if (cached) return cached;
  const [specs, exposures] = await Promise.all([
    loadSpecs(project_id),
    loadExposures(project_id),
  ]);
  const value = { specs, exposures };
  cache.set(project_id, value);
  return value;
}

export function invalidatePublicAppCache(project_id?: string): void {
  if (project_id) {
    cache.delete(project_id);
  } else {
    cache.clear();
  }
}

export async function authorizePublicAppPath({
  project_id,
  url,
}: {
  project_id: string;
  url?: string;
}): Promise<boolean> {
  if (!url) return false;
  const parsed = new URL(url, "http://project-host.local");
  const projectPrefix = normalizePrefix(`/${project_id}`);
  const pathname = parsed.pathname;
  if (!(pathname === projectPrefix || pathname.startsWith(`${projectPrefix}/`))) {
    return false;
  }
  const localPath = normalizePrefix(pathname.slice(projectPrefix.length) || "/");
  const { specs, exposures } = await getAppData(project_id);
  const now = Date.now();
  for (const spec of specs) {
    const basePath = normalizePrefix(spec.proxy?.base_path ?? "/");
    if (!(localPath === basePath || localPath.startsWith(`${basePath}/`))) {
      continue;
    }
    const exposure = exposures[spec.id];
    if (!exposure || exposure.mode !== "public") {
      return false;
    }
    if (
      Number.isFinite(Number(exposure.expires_at_ms)) &&
      Number(exposure.expires_at_ms) <= now
    ) {
      return false;
    }
    if (exposure.auth_front === "token") {
      const token = `${parsed.searchParams.get(APP_PUBLIC_TOKEN_QUERY_PARAM) ?? ""}`.trim();
      if (!token || !exposure.token || token !== exposure.token) {
        return false;
      }
    }
    logger.debug("authorizePublicAppPath: allowed", {
      project_id,
      app_id: spec.id,
      localPath,
    });
    return true;
  }
  return false;
}
