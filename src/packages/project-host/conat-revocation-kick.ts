import type { Client } from "@cocalc/conat/core/client";
import { sysApi } from "@cocalc/conat/core/sys";
import getLogger from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import { isAccountSessionRevoked } from "./conat-auth";

const logger = getLogger("project-host:conat-revocation-kick");

const configuredSweepMs = Number(
  process.env.COCALC_PROJECT_HOST_CONAT_REVOKE_SWEEP_MS,
);
const DEFAULT_SWEEP_MS = Number.isFinite(configuredSweepMs)
  ? Math.max(5_000, configuredSweepMs)
  : 30_000;

function getIssuedAtSeconds(user: any): number {
  const iat = Number(user?.auth_iat_s);
  if (Number.isFinite(iat) && iat > 0) {
    return Math.floor(iat);
  }
  // Fail closed if this is an account identity without explicit iat.
  return 0;
}

export function startConatRevocationKickLoop({
  client,
  sweepIntervalMs = DEFAULT_SWEEP_MS,
}: {
  client: Client;
  sweepIntervalMs?: number;
}): () => void {
  const api = sysApi(client);
  let running = false;

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const statsByServer = await api.stats();
      const ids = new Set<string>();
      for (const socketStatsById of Object.values(statsByServer ?? {})) {
        for (const [socketId, stats] of Object.entries(socketStatsById ?? {})) {
          const user = (stats as any)?.user;
          const account_id = `${user?.account_id ?? ""}`.trim();
          if (!isValidUUID(account_id)) continue;
          if (
            isAccountSessionRevoked({
              account_id,
              issued_at_s: getIssuedAtSeconds(user),
            })
          ) {
            ids.add(socketId);
          }
        }
      }
      if (ids.size > 0) {
        const socketIds = Array.from(ids);
        logger.info("disconnecting revoked conat sessions", {
          count: socketIds.length,
        });
        await api.disconnect(socketIds);
      }
    } catch (err) {
      logger.debug("conat revocation sweep failed", { err });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(sweep, Math.max(5_000, Math.floor(sweepIntervalMs)));
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
