/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";

export type PublicRootfsRoute =
  | { view: "index" }
  | { imageId: string; view: "image-id" }
  | { slug: string; view: "slug" };

function getBaseOffset(): number {
  return appBasePath === "/"
    ? 0
    : appBasePath.split("/").filter(Boolean).length;
}

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  return parts.slice(getBaseOffset());
}

function basePathPrefix(): string {
  return appBasePath === "/" ? "" : appBasePath;
}

export function getRootfsRouteFromPath(pathname: string): PublicRootfsRoute {
  const routeParts = getRouteParts(pathname);
  if (routeParts[0] !== "rootfs") {
    return { view: "index" };
  }
  if (routeParts[1] === "id" && routeParts[2]) {
    return { imageId: decodeURIComponent(routeParts[2]), view: "image-id" };
  }
  if (routeParts[1]) {
    return { slug: decodeURIComponent(routeParts[1]), view: "slug" };
  }
  return { view: "index" };
}

export function rootfsPath(entry?: Pick<RootfsImageEntry, "id" | "slug">) {
  const base = basePathPrefix();
  const slug = entry?.slug?.trim();
  if (slug) {
    return `${base}/rootfs/${encodeURIComponent(slug)}`;
  }
  const id = entry?.id?.trim();
  if (id) {
    return `${base}/rootfs/id/${encodeURIComponent(id)}`;
  }
  return `${base}/rootfs`;
}
