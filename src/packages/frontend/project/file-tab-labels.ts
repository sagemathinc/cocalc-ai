/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Utility function for determining the labels to put on file tabs.
*/

import { path_split } from "@cocalc/util/misc";

export function file_tab_labels(
  paths: string[],
  preferredLabels?: Array<string | undefined>,
): string[] {
  const labels: string[] = [];
  const counts: { [filename: string]: number } = {};
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    const { tail } = path_split(path);
    const label = preferredLabels?.[i] ?? tail;
    counts[label] = counts[label] === undefined ? 1 : counts[label] + 1;
    labels.push(label);
  }
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (counts[label] > 1) {
      labels[i] = paths[i];
    }
  }
  return labels;
}
