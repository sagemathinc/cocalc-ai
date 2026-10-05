/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("conat-server");

export type BayConnection = [id: string, user: any];

/**
 * One revocation pass over the seed's bay connections. Revoked credentials
 * are disconnected. If the registry cannot be checked, retry once: an event
 * loop stall can expire the check's timer even though the database answered,
 * and evicting every bay over that would only churn the fabric. If the retry
 * also fails, disconnect every bay principal rather than extending access;
 * bays reconnect and are authenticated again once the registry is reachable.
 */
export async function sweepBayCredentialConnections({
  connections,
  isActive,
  disconnect,
}: {
  connections: BayConnection[];
  isActive: (user: any) => Promise<boolean>;
  disconnect: (ids: string[]) => void;
}): Promise<void> {
  if (!connections.length) return;
  const check = async () =>
    await Promise.all(
      connections.map(async ([id, user]) => ({
        id,
        active: await isActive(user),
      })),
    );
  let checks: { id: string; active: boolean }[];
  try {
    checks = await check();
  } catch (firstErr) {
    logger.warn("bay credential revocation check failed; retrying once", {
      count: connections.length,
      err: `${firstErr}`,
    });
    try {
      checks = await check();
    } catch (err) {
      // Registry availability is part of bay authentication. If it cannot be
      // checked, disconnect every bay principal rather than extending access.
      const ids = connections.map(([id]) => id);
      logger.error(
        "failed to check bay credential revocations; disconnecting bay connections",
        { count: ids.length, err },
      );
      disconnect(ids);
      return;
    }
  }
  const revoked = checks.filter(({ active }) => !active).map(({ id }) => id);
  if (revoked.length) {
    logger.info("disconnecting revoked bay credential connections", {
      count: revoked.length,
    });
    disconnect(revoked);
  }
}
