/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ALL_AVAIL } from "@cocalc/frontend/project_configuration";

// ws: I fundamentally disagree with this. We should show what we support,
// and make it easy to install support for things that aren't installed.
const DISABLED = true;

export function useAvailableFeatures(project_id: string) {
  void project_id;
  if (DISABLED) {
    return ALL_AVAIL;
  }
  return ALL_AVAIL;
}
