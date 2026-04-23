/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Actions } from "./types";

export function isSyncstringLiveConnected(actions?: Actions): boolean {
  const syncstring = actions?._syncstring as
    | {
        is_live_connected?: () => boolean;
        get_state?: () => string;
      }
    | undefined;
  if (syncstring == null) return true;
  if (typeof syncstring.is_live_connected === "function") {
    return syncstring.is_live_connected();
  }
  return syncstring.get_state?.() === "ready";
}
