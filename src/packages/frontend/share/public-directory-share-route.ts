/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ShareRouteCandidate = {
  slug: string;
  relativePath: string;
};

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
