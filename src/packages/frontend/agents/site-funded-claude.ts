/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Whether this account can choose included Claude (CoCalc Membership): the
// site offers it and the membership includes AI usage. Asked once, then
// reused for a few minutes; every turn is still admitted on its own.

import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const TTL_MS = 5 * 60_000;
let cached: { at: number; available: Promise<boolean> } | undefined;

export function siteFundedClaudeAvailable(): Promise<boolean> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    cached = {
      at: Date.now(),
      // Unknown (no connection yet, an old hub): not offered.
      available: (async () =>
        (
          await webapp_client.conat_client.hub.system.getSiteFundedClaudeAvailability(
            {},
          )
        )?.available === true)().catch(() => false),
    };
  }
  return cached.available;
}

export function useSiteFundedClaudeAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void siteFundedClaudeAvailable().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

export function resetSiteFundedClaudeAvailabilityForTests(): void {
  cached = undefined;
}
