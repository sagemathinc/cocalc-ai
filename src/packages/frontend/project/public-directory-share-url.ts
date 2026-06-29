/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { relative } from "path";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { toAbsoluteProjectPath } from "./sync-path";
import { normalize } from "./utils";

export function encodeShareRoutePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function relativeShareRoute({
  shareRoot,
  targetPath,
}: {
  shareRoot: string;
  targetPath: string;
}): string | undefined {
  const relativePath = relative(shareRoot, targetPath).replace(/\\/g, "/");
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("/")
  ) {
    return undefined;
  }
  return encodeShareRoutePath(relativePath);
}

export function publicDirectoryShareUrlForDisplayPath({
  displayPath,
  projectHome,
  sharePath,
  slug,
}: {
  displayPath: string;
  projectHome: string;
  sharePath: string;
  slug: string;
}): string | undefined {
  const normalizedSlug = slug.trim();
  const normalizedSharePath = sharePath.trim().replace(/^\/+|\/+$/g, "");
  if (!normalizedSlug || !normalizedSharePath) return;
  const shareRoot =
    normalizedSharePath === "."
      ? projectHome
      : normalize(toAbsoluteProjectPath(normalizedSharePath, projectHome));
  const relativeRoute = relativeShareRoute({
    shareRoot,
    targetPath: displayPath,
  });
  if (relativeRoute == null) return;
  const slugPath = encodeShareRoutePath(normalizedSlug);
  return relativeRoute
    ? `/share/${slugPath}/${relativeRoute}`
    : `/share/${slugPath}`;
}

export function publicDirectoryShareUrlForLocalUrl({
  localUrl,
  shareRoot,
  slug,
}: {
  localUrl: string;
  shareRoot: string;
  slug: string;
}): string | undefined {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) return;
  const slugPath = encodeShareRoutePath(normalizedSlug);
  if (localUrl === "files" || localUrl === "files/") {
    return `/share/${slugPath}`;
  }
  if (!localUrl.startsWith("files/")) return;
  const rawPath = localUrl.slice("files/".length);
  const targetPath = normalizeAbsolutePath(
    rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
  );
  const relativeRoute = relativeShareRoute({ shareRoot, targetPath });
  if (relativeRoute == null) {
    return `/share/${slugPath}`;
  }
  return relativeRoute
    ? `/share/${slugPath}/${relativeRoute}`
    : `/share/${slugPath}`;
}
