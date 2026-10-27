/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// One site-funded Claude conversation's turns: each is admitted (reserved
// against the account's included AI and a site key) when it starts, funds the
// relay while it runs, and is settled when it ends. The relay funds nothing
// between turns.

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import type { SiteFundedUsageWarning } from "@cocalc/util/ai/site-funded-codex";
import {
  finishSiteFundedTurn,
  getSiteFundedClaudeKey,
  heartbeatSiteFundedTurn,
  persistSiteFundedUsageEvent,
  reserveSiteFundedTurn,
} from "../codex/codex-site-metering";
import type { SiteFundedClaudeRelay } from "./site-funded-claude-relay";

const logger = getLogger("project-host:site-funded-claude-turns");

export type SiteFundedTurnEnd = {
  status: "committed" | "interrupted" | "failed" | "released";
  outcome?: string;
};

export interface SiteFundedClaudeTurns {
  /** Admits the turn; usageWarning is set when the account is close to a limit. */
  begin(
    chat?: AcpChatContext,
  ): Promise<{ usageWarning?: SiteFundedUsageWarning }>;
  end(end: SiteFundedTurnEnd): Promise<void>;
  close(): Promise<void>;
}

// For tests.
export type SiteFundedClaudeTurnsDeps = {
  reserve: typeof reserveSiteFundedTurn;
  getKey: typeof getSiteFundedClaudeKey;
  heartbeat: typeof heartbeatSiteFundedTurn;
  finish: typeof finishSiteFundedTurn;
  persistUsage: typeof persistSiteFundedUsageEvent;
};

const defaultDeps: SiteFundedClaudeTurnsDeps = {
  reserve: reserveSiteFundedTurn,
  getKey: getSiteFundedClaudeKey,
  heartbeat: heartbeatSiteFundedTurn,
  finish: finishSiteFundedTurn,
  persistUsage: persistSiteFundedUsageEvent,
};

export function createSiteFundedClaudeTurns({
  relay,
  projectId,
  accountId,
  deps = defaultDeps,
}: {
  relay: SiteFundedClaudeRelay;
  projectId: string;
  accountId: string;
  deps?: SiteFundedClaudeTurnsDeps;
}): SiteFundedClaudeTurns {
  let active:
    | { reservationId: string; heartbeat: ReturnType<typeof setInterval> }
    | undefined;
  let closed = false;

  const end = async ({ status, outcome }: SiteFundedTurnEnd) => {
    const current = active;
    if (!current) return;
    active = undefined;
    clearInterval(current.heartbeat);
    // Its running request's usage is queued before the turn is settled.
    await relay.deactivate(current.reservationId);
    await deps.finish({
      reservation_id: current.reservationId,
      status,
      outcome: outcome?.slice(0, 500),
    });
  };

  return {
    begin: async (chat) => {
      if (closed) throw new Error("This Claude conversation has closed.");
      if (active) {
        // A turn whose end never arrived: never leave it funding the relay.
        await end({ status: "released", outcome: "superseded by a new turn" });
      }
      const fundedTurnId = randomUUID();
      const admission = await deps.reserve({
        provider: "anthropic",
        accountId,
        projectId,
        fundedTurnId,
        idempotencyKey: fundedTurnId,
        path: chat?.path,
      });
      const { reservation } = admission;
      try {
        const apiKey = await deps.getKey(reservation.reservationId);
        relay.activate({
          reservation,
          apiKey,
          onUsage: deps.persistUsage,
        });
      } catch (err) {
        await deps.finish({
          reservation_id: reservation.reservationId,
          status: "released",
          outcome: "site key unavailable",
        });
        throw err;
      }
      const heartbeat = setInterval(() => {
        void deps
          .heartbeat(reservation.reservationId)
          .then((stillActive) => {
            // The hub ended it (expired, say): stop funding at once.
            if (!stillActive) void relay.deactivate(reservation.reservationId);
          })
          .catch((err) =>
            logger.warn("site-funded Claude heartbeat failed", {
              reservationId: reservation.reservationId,
              err: `${err}`,
            }),
          );
      }, reservation.heartbeatIntervalMs);
      heartbeat.unref?.();
      active = { reservationId: reservation.reservationId, heartbeat };
      return admission.usageWarning
        ? { usageWarning: admission.usageWarning }
        : {};
    },
    end,
    close: async () => {
      closed = true;
      await end({ status: "released", outcome: "Claude harness closed" });
    },
  };
}
