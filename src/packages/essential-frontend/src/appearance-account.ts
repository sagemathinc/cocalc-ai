/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { saveAccountAppearance as save } from "@cocalc/conat/hub/account-appearance";
import { getAppBasePath } from "./urls";

export function saveAccountAppearance(
  account: Parameters<typeof save>[0],
  preference: Parameters<typeof save>[1],
) {
  return save(account, preference, getAppBasePath());
}
