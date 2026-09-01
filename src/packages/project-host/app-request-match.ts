/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import TTL from "@isaacs/ttlcache";
import { getMountPoint } from "./file-server";
import type { AppStaticIntegrationSpec } from "./public-viewer";

const SUPPORT_FILES = new Set([
  "runtime-state.json",
  "metrics-state.json",
  "host-metrics-state.json",
]);

export interface AppSpec {
  id: string;
  kind: "service" | "static";
  proxy?: { base_path?: string; strip_prefix?: boolean };
  static?: {
    root?: string;
    index?: string;
    cache_control?: string;
  };
  integration?: AppStaticIntegrationSpec;
}

export interface AppRequestMatch {
  spec: AppSpec;
  localPath: string;
  requestPath: string;
}

const cache = new TTL<string, AppSpec[]>({ max: 10_000, ttl: 1_000 });

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
    if (!name.endsWith(".json") || SUPPORT_FILES.has(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!parsed?.id || !parsed?.proxy?.base_path) continue;
      out.push(parsed as AppSpec);
    } catch {
      // Invalid app specs are reported by the project-side app manager.
    }
  }
  return out;
}

async function getAppSpecs(project_id: string): Promise<AppSpec[]> {
  const cached = cache.get(project_id);
  if (cached) return cached;
  const specs = await loadSpecs(project_id);
  cache.set(project_id, specs);
  return specs;
}

export async function matchAppRequest({
  project_id,
  url,
}: {
  project_id: string;
  url?: string;
}): Promise<AppRequestMatch | undefined> {
  if (!url) return;
  const parsed = new URL(url, "http://project-host.local");
  const projectPrefix = normalizePrefix(`/${project_id}`);
  const pathname = parsed.pathname;
  if (
    !(pathname === projectPrefix || pathname.startsWith(`${projectPrefix}/`))
  ) {
    return;
  }
  const localPath = normalizePrefix(
    pathname.slice(projectPrefix.length) || "/",
  );
  for (const spec of await getAppSpecs(project_id)) {
    const basePath = normalizePrefix(spec.proxy?.base_path ?? "/");
    if (!(localPath === basePath || localPath.startsWith(`${basePath}/`))) {
      continue;
    }
    const suffix =
      localPath.length > basePath.length
        ? localPath.slice(basePath.length)
        : "";
    const requestPath =
      spec.proxy?.strip_prefix === false
        ? `${localPath}${parsed.search ?? ""}`
        : `${suffix || "/"}${parsed.search ?? ""}`;
    return { spec, localPath, requestPath };
  }
}

export function invalidateAppRequestCache(project_id?: string): void {
  if (project_id) {
    cache.delete(project_id);
  } else {
    cache.clear();
  }
}
