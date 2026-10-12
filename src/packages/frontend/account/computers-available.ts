/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";

/**
 * Computers are a cocalc.ai feature for now (and Star, which runs the same
 * hub): not CoCalc Lite, and not Launchpad, whose API doesn't serve them.
 * Every computers UI checks this, so none of it appears where it can't work.
 */
export function useComputersAvailable(): boolean {
  const isLaunchpad = useTypedRedux("customize", "is_launchpad");
  return !lite && !isLaunchpad;
}
