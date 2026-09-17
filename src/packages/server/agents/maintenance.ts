/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { agentStore } from "./store";

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
    const result: CleanupResult = {};
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
    // Aliases must be removed before their canonical request because of the
    // self-reference. Old pending rows are expired by time even if their
    // stored state was never rewritten.
    await remove(
      db,
      "request_aliases",
      `DELETE FROM agent_personal_requests WHERE request_id IN
       (SELECT request_id FROM agent_personal_requests
        WHERE canonical_request_id IS NOT NULL
          AND expires_at<now()-interval '30 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "requests",
      `DELETE FROM agent_personal_requests WHERE request_id IN
       (SELECT request_id FROM agent_personal_requests
        WHERE canonical_request_id IS NULL
          AND expires_at<now()-interval '30 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "personal_grants",
      `DELETE FROM agent_personal_grants WHERE link_id IN
       (SELECT g.link_id FROM agent_personal_grants g
        LEFT JOIN agent_personal_controls c USING(account_id)
        WHERE (g.revoked_at<now()-interval '180 days'
          OR g.expires_at<now()-interval '180 days'
          OR (g.created_at<now()-interval '180 days'
              AND g.generation<COALESCE(c.generation,0))) LIMIT $1)`,
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
    await remove(
      db,
      "rpc_links",
      `DELETE FROM agent_rpc_links WHERE link_id IN
       (SELECT link_id FROM agent_rpc_links
        WHERE expires_at<now()-interval '180 days'
          OR revoked_at<now()-interval '180 days' LIMIT $1)`,
      result,
    );
    // Legacy uncertain/dispatched inbox state is intentionally retained. Only
    // rejected work is unambiguously terminal and safe to remove.
    await remove(
      db,
      "rejected_inbox",
      `DELETE FROM agent_message_inbox WHERE message_id IN
       (SELECT message_id FROM agent_message_inbox
        WHERE state='rejected' AND updated_at<now()-interval '180 days' LIMIT $1)`,
      result,
    );
    await remove(
      db,
      "legacy_grants",
      `DELETE FROM agent_message_grants WHERE grant_id IN
       (SELECT g.grant_id FROM agent_message_grants g
        WHERE (g.revoked_at<now()-interval '180 days'
               OR g.expires_at<now()-interval '180 days')
          AND NOT EXISTS (SELECT 1 FROM agent_message_inbox i
                          WHERE i.grant_id=g.grant_id)
        LIMIT $1)`,
      result,
    );
    return result;
  });
}

export function startAgentMessagingMaintenance(): () => void {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void cleanupAgentMessagingHistory().then(
      (removed) => {
        if (Object.values(removed).some(Boolean))
          logger.info("removed retained agent messaging history", removed);
      },
      (error) => logger.warn("agent messaging maintenance failed", { error }),
    );
  };
  const initial = setTimeout(run, 60_000);
  initial.unref();
  const interval = setInterval(run, INTERVAL_MS);
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
