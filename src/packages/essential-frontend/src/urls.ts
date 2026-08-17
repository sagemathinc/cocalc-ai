/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export function getAppBasePath(pathname = window.location.pathname): string {
  for (const marker of ["/essential/", "/static/"]) {
    const index = pathname.indexOf(marker);
    if (index >= 0) return pathname.slice(0, index).replace(/\/$/, "");
  }
  if (pathname.endsWith("/essential")) {
    return pathname.slice(0, -"/essential".length).replace(/\/$/, "");
  }
  return "";
}

export function siteUrl(path: string, basePath = getAppBasePath()): string {
  const relative = path.replace(/^\/+/, "");
  return `${basePath}/${relative}`;
}

export function authBootstrapUrl(basePath = getAppBasePath()): string {
  return siteUrl("api/v2/auth/bootstrap", basePath);
}

export function fullProjectUrl({
  projectId,
  path,
  basePath = getAppBasePath(),
}: {
  projectId: string;
  path?: string;
  basePath?: string;
}): string {
  const root = siteUrl(`projects/${projectId}/files`, basePath);
  if (!path) return `${root}/`;
  const relative = path.replace(/^\/+/, "");
  return relative
    ? `${root}/${relative.split("/").map(encodeURIComponent).join("/")}`
    : `${root}/`;
}

export function fullProjectToolUrl({
  projectId,
  tool,
  basePath = getAppBasePath(),
}: {
  projectId: string;
  tool: "servers" | "vms";
  basePath?: string;
}): string {
  return siteUrl(`projects/${projectId}/${tool}`, basePath);
}
