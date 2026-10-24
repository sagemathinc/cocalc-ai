/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Whether this account can choose included Claude (CoCalc Membership): the
// site offers it and the membership includes AI usage. Asked once per
// account, then reused for a few minutes; every turn is still admitted on
// its own.

import { useEffect, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; available: Promise<boolean> }>();

export function siteFundedClaudeAvailable(
  accountId: string | undefined = webapp_client.account_id,
): Promise<boolean> {
  // Not signed in, or not the account this session answers for: nothing
  // to offer.
  if (!accountId || accountId !== webapp_client.account_id) {
    return Promise.resolve(false);
  }
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at <= TTL_MS) return cached.available;
  const entry = {
    at: Date.now(),
    // Unknown (no connection yet, an old hub): not offered.
    available: (async () =>
      (
        await webapp_client.conat_client.hub.system.getSiteFundedClaudeAvailability(
          {},
        )
      )?.available === true)().catch(() => false),
  };
  cache.set(accountId, entry);
  return entry.available;
}

export function useSiteFundedClaudeAvailable(): boolean {
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    // Another account: never its predecessor's answer, even briefly.
    setAvailable(false);
    let live = true;
    void siteFundedClaudeAvailable(accountId).then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, [accountId]);
  return available;
}

export function resetSiteFundedClaudeAvailabilityForTests(): void {
  cache.clear();
}
