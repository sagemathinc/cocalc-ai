/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { agentStore } from "./store";
import { cleanupCocalcConnectorCredentials } from "./cocalc-connector-retention";

const logger = getLogger("agents:maintenance");
const BATCH = 5000;
const INTERVAL_MS = 6 * 60 * 60_000;

type CleanupResult = Record<string, number>;

async function remove(
  db: { query: (sql: string, values?: unknown[]) => Promise<any> },
  name: string,
  sql: string,
  result: CleanupResult,
) {
  result[name] = (await db.query(sql, [BATCH])).rowCount ?? 0;
}

export async function cleanupAgentMessagingHistory(): Promise<CleanupResult> {
  return agentStore().transaction(async (db) => {
    const locked = (
      await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('agent-messaging-maintenance',0)) AS locked",
      )
    ).rows[0]?.locked;
    if (!locked) return {};
    const result: CleanupResult = await cleanupCocalcConnectorCredentials(
      db,
      BATCH,
    );
    await remove(
      db,
      "admission",
      `DELETE FROM agent_rpc_admission_state WHERE token_id IN
       (SELECT token_id FROM agent_rpc_admission_state WHERE expires_at<now() LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "runs",
      `DELETE FROM agent_identity_runs WHERE (agent_id,run_id) IN
       (SELECT agent_id,run_id FROM agent_identity_runs
        WHERE COALESCE(ended_at,expires_at)<now()-interval '30 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "network_mutations",
      `DELETE FROM agent_network_mutations WHERE (account_id,request_id) IN
       (SELECT account_id,request_id FROM agent_network_mutations
        WHERE created_at<now()-interval '30 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "network_activity",
      `DELETE FROM agent_network_activity WHERE attempt_id IN
       (SELECT attempt_id FROM agent_network_activity
        WHERE observed_at<now()-interval '180 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "network_proposals",
      `DELETE FROM agent_network_proposals WHERE proposal_id IN
       (SELECT proposal_id FROM agent_network_proposals
        WHERE expires_at<now()-interval '30 days'
          OR (resolved_at IS NOT NULL AND resolved_at<now()-interval '30 days')
        LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "network_broadcasts",
      `DELETE FROM agent_network_broadcasts WHERE (account_id,broadcast_id) IN
       (SELECT account_id,broadcast_id FROM agent_network_broadcasts
        WHERE created_at<now()-interval '30 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "external_inbox",
      `DELETE FROM agent_external_inbox WHERE message_id IN
       (SELECT message_id FROM agent_external_inbox
        WHERE expires_at<now()
          OR (state='acknowledged' AND acknowledged_at<now()-interval '30 days')
        LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "external_installations",
      `DELETE FROM agent_external_installations WHERE installation_id IN
       (SELECT installation_id FROM agent_external_installations
        WHERE expires_at<now()-interval '180 days'
          OR (state='revoked' AND created_at<now()-interval '180 days')
        LIMIT $1)`,
      result,
    );
    return result;
  });
}

export function startAgentMessagingMaintenance(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref();
  };
  const run = async () => {
    if (stopped) return;
    let delay = INTERVAL_MS;
    try {
      const removed = await cleanupAgentMessagingHistory();
      if (Object.values(removed).some(Boolean))
        logger.info("removed retained agent messaging history", removed);
      // A full batch signals possible backlog. Yield between bounded transactions
      // instead of limiting cleanup throughput to one batch every six hours.
      if (Object.values(removed).some((count) => count >= BATCH)) delay = 1_000;
    } catch (error) {
      logger.warn("agent messaging maintenance failed", { error });
      delay = 60_000;
    } finally {
      schedule(delay);
    }
  };
  schedule(60_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
