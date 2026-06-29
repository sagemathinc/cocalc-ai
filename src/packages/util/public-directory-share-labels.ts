/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX = "system/public-share/";
export const MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH = 200;
export const MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH = 120;

export interface PublicDirectoryShareProjectLabel {
  id: string;
  path: string;
  slug: string;
  title?: string;
  requires_auth?: boolean;
  visibility?: string;
  whole_project?: boolean;
}

export interface PublicDirectorySharePathIndicators {
  direct: PublicDirectoryShareProjectLabel[];
  descendants: PublicDirectoryShareProjectLabel[];
  ancestors: PublicDirectoryShareProjectLabel[];
}

const MAX_PROJECT_LABEL_VALUE_LENGTH = 512;

export function publicDirectoryShareProjectLabelKey(id: string): string {
  return `${PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX}${id}`;
}

function normalizeProjectPath(path: string | null | undefined): string {
  let value = `${path ?? ""}`.trim();
  if (value === "" || value === "." || value === "/" || value === "~") {
    return ".";
  }
  value = value.replace(/^\/home\/user\/?/, "");
  value = value.replace(/^\/root\/?/, "");
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return value === "" ? "." : value;
}

function isSamePath(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}

function isAncestorPath(parent: string, child: string): boolean {
  const normalizedParent = normalizeProjectPath(parent);
  const normalizedChild = normalizeProjectPath(child);
  if (normalizedParent === normalizedChild) return false;
  if (normalizedParent === ".") return normalizedChild !== ".";
  return normalizedChild.startsWith(`${normalizedParent}/`);
}

function shortString(value: unknown, maxLength: number): string | undefined {
  const str = `${value ?? ""}`.trim();
  if (!str) return undefined;
  return str.length <= maxLength ? str : `${str.slice(0, maxLength - 1)}…`;
}

export function publicDirectoryShareProjectLabelValue(opts: {
  path: string;
  slug: string;
  title?: string | null;
  requires_auth?: boolean | null;
  visibility?: string | null;
}): string | null {
  const path = normalizeProjectPath(opts.path);
  const value = JSON.stringify({
    v: 1,
    p: path,
    s: shortString(opts.slug, MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH),
    t: shortString(opts.title, 80),
    a: opts.requires_auth === false ? 0 : 1,
    z: shortString(opts.visibility, 16),
    w: path === "." ? 1 : undefined,
  });
  if (value.length > MAX_PROJECT_LABEL_VALUE_LENGTH) {
    return null;
  }
  return value;
}

export function parsePublicDirectoryShareProjectLabel(
  key: string,
  value: unknown,
): PublicDirectoryShareProjectLabel | undefined {
  if (!key.startsWith(PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX)) return undefined;
  const id = key.slice(PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX.length).trim();
  if (!id) return undefined;
  try {
    const parsed = JSON.parse(`${value ?? ""}`);
    if (parsed?.v !== 1 || typeof parsed.p !== "string") return undefined;
    return {
      id,
      path: normalizeProjectPath(parsed.p),
      slug: typeof parsed.s === "string" ? parsed.s : "",
      title: typeof parsed.t === "string" ? parsed.t : undefined,
      requires_auth: parsed.a !== 0,
      visibility: typeof parsed.z === "string" ? parsed.z : undefined,
      whole_project: parsed.w === 1 || normalizeProjectPath(parsed.p) === ".",
    };
  } catch {
    return undefined;
  }
}

export function publicDirectoryShareLabelsFromProjectLabels(
  labels: unknown,
): PublicDirectoryShareProjectLabel[] {
  const values = (labels as any)?.toJS?.() ?? labels ?? {};
  if (values == null || typeof values !== "object") return [];
  const result: PublicDirectoryShareProjectLabel[] = [];
  for (const [key, value] of Object.entries(values)) {
    const label = parsePublicDirectoryShareProjectLabel(key, value);
    if (label != null) result.push(label);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function publicDirectoryShareIndicatorsForPath({
  labels,
  path,
}: {
  labels: PublicDirectoryShareProjectLabel[];
  path: string;
}): PublicDirectorySharePathIndicators {
  const normalizedPath = normalizeProjectPath(path);
  return {
    direct: labels.filter((label) => isSamePath(label.path, normalizedPath)),
    descendants: labels.filter((label) =>
      isAncestorPath(normalizedPath, label.path),
    ),
    ancestors: labels.filter((label) =>
      isAncestorPath(label.path, normalizedPath),
    ),
  };
}
