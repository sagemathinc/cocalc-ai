/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ShareRouteCandidate = {
  slug: string;
  relativePath: string;
};

export function shareRouteCandidates(rawPath: string): ShareRouteCandidate[] {
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);
  const candidates: ShareRouteCandidate[] = [];
  for (let i = segments.length; i >= 1; i -= 1) {
    candidates.push({
      slug: segments.slice(0, i).join("/"),
      relativePath: segments.slice(i).join("/"),
    });
  }
  return candidates;
}
