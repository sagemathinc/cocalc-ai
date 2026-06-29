/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publicDirectoryShareLabelsFromProjectLabels } from "@cocalc/util/public-directory-share-labels";

export function publicShareCountFromProjectLabels(labels: unknown): number {
  return publicDirectoryShareLabelsFromProjectLabels(
    normalizeProjectLabels(labels),
  ).length;
}

export function publicShareCountFromProject(project: any): number {
  return publicShareCountFromProjectLabels(project?.get?.("labels"));
}

function normalizeProjectLabels(labels: unknown): Record<string, string> {
  if (labels == null) return {};
  if (typeof (labels as { toJS?: unknown }).toJS === "function") {
    return normalizeProjectLabels((labels as { toJS: () => unknown }).toJS());
  }
  if (typeof labels !== "object") return {};
  return labels as Record<string, string>;
}
