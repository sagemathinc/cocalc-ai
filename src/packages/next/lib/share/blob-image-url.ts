/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import ROOT_PATH from "lib/root-path";

export function blobImageUrl(
  blob: string | undefined | null,
  filename = "project-image.png",
): string | undefined {
  const trimmed = `${blob ?? ""}`.trim();
  if (!trimmed) return undefined;
  return `${ROOT_PATH}blobs/${encodeURIComponent(filename)}?uuid=${encodeURIComponent(trimmed)}`;
}
