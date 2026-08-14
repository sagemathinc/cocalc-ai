/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ShareRouteCandidate = {
  slug: string;
  relativePath: string;
};

type ClassifySharePathOptions = {
  relativePath: string;
  listDirectory: () => Promise<unknown>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
};

const DIRECTORY_PROBE_RETRY_DELAYS_MS = [150, 500, 1500, 3000] as const;

const CAMBRIDGE_LEGACY_SLUG_PREFIX = "Cambridge/";
const LEGACY_FILES_SEPARATOR = "files";

function cambridgeLegacyFilesCandidate({
  slug,
  relativePath,
}: ShareRouteCandidate): ShareRouteCandidate | undefined {
  if (!slug.startsWith(CAMBRIDGE_LEGACY_SLUG_PREFIX)) {
    return;
  }
  if (relativePath === LEGACY_FILES_SEPARATOR) {
    return { slug, relativePath: "" };
  }
  if (relativePath.startsWith(`${LEGACY_FILES_SEPARATOR}/`)) {
    return {
      slug,
      relativePath: relativePath.slice(LEGACY_FILES_SEPARATOR.length + 1),
    };
  }
}

export function shareRouteCandidates(rawPath: string): ShareRouteCandidate[] {
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);
  const candidates: ShareRouteCandidate[] = [];
  for (let i = segments.length; i >= 1; i -= 1) {
    const candidate = {
      slug: segments.slice(0, i).join("/"),
      relativePath: segments.slice(i).join("/"),
    };
    const legacyCandidate = cambridgeLegacyFilesCandidate(candidate);
    if (legacyCandidate != null) {
      candidates.push(legacyCandidate);
    }
    candidates.push(candidate);
  }
  return candidates;
}

export function exactFileShareRouteAllowed({
  sharePath,
  relativePath,
}: {
  sharePath: string;
  relativePath: string;
}): boolean {
  const suffix = relativePath.replace(/^\/+|\/+$/g, "");
  if (!suffix) return true;
  const normalizedSharePath = sharePath.replace(/^\/+|\/+$/g, "");
  const parts = normalizedSharePath.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";
  return suffix === basename || suffix === normalizedSharePath;
}

export function retainedLegacyShareRelativePath({
  legacyPublicPathId,
  relativePath,
}: {
  legacyPublicPathId?: string | null;
  relativePath: string;
}): string {
  if (!legacyPublicPathId) return relativePath;
  const normalized = relativePath.replace(/^\/+|\/+$/g, "");
  if (normalized === LEGACY_FILES_SEPARATOR) return "";
  if (normalized.startsWith(`${LEGACY_FILES_SEPARATOR}/`)) {
    return normalized.slice(LEGACY_FILES_SEPARATOR.length + 1);
  }
  return relativePath;
}

function errorDetails(error: unknown): string {
  if (error == null) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error !== "object") {
    return `${error}`;
  }
  const value = error as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
  };
  return [value.code, value.message, errorDetails(value.error)]
    .filter((part) => part != null && `${part}`.length > 0)
    .join(" ");
}

function isNotDirectoryError(error: unknown): boolean {
  return /(?:^|\b)ENOTDIR(?:\b|$)|not a directory/i.test(errorDetails(error));
}

async function defaultWait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Determine whether the path after a resolved share slug is a directory.
 * Project-host routing and temporary viewer authorization can take a moment to
 * become usable, so only ENOTDIR is accepted as proof that the path is a file.
 */
export async function classifySharePath({
  relativePath,
  listDirectory,
  retryDelaysMs = DIRECTORY_PROBE_RETRY_DELAYS_MS,
  wait = defaultWait,
}: ClassifySharePathOptions): Promise<"directory" | "file"> {
  if (relativePath.trim() === "") {
    return "directory";
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await wait(retryDelaysMs[attempt - 1]);
    }
    try {
      await listDirectory();
      return "directory";
    } catch (error) {
      if (isNotDirectoryError(error)) {
        return "file";
      }
      lastError = error;
    }
  }
  throw lastError ?? new Error("Unable to inspect the published path");
}
