/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The broker's database dependencies: the grant and connection lookup, the
// site allowlist, the append-only mint log, and the per-lease lock.

import getPool from "@cocalc/database/pool";
import {
  isGcpProjectNumber,
  isWifPoolOrProviderId,
} from "@cocalc/util/ai/federated-connectors";
import type {
  BrokerDeps,
  ConnectionRecord,
  GrantRecord,
  MintLogRow,
} from "./broker";

/** The setup_results key recording the connection's audience test. */
export const AUDIENCE_TEST_KEY = "audience_test";

export const loadGrant: BrokerDeps["loadGrant"] = async ({
  account_id,
  grant_id,
}) => {
  const { rows } = await getPool().query(
    `SELECT g.grant_id, g.account_id, g.connection_id, g.revision, g.state,
            g.service_account, g.sa_label, g.target_project,
            g.permission_profile,
            c.account_id AS c_account_id, c.provider, c.state AS c_state,
            c.setup_results->>'${AUDIENCE_TEST_KEY}' AS audience_test,
            c.pool_project_number, c.pool_id, c.provider_id
       FROM federated_connector_grants g
       JOIN federated_connector_connections c
         ON c.connection_id = g.connection_id
      WHERE g.grant_id = $1 AND g.account_id = $2`,
    [grant_id, account_id],
  );
  const row = rows[0];
  if (!row) return null;
  const grant: GrantRecord = {
    grant_id: row.grant_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    revision: row.revision,
    state: row.state,
    service_account: row.service_account,
    sa_label: row.sa_label,
    target_project: row.target_project,
    permission_profile: row.permission_profile,
  };
  const complete =
    isGcpProjectNumber(row.pool_project_number) &&
    isWifPoolOrProviderId(row.pool_id) &&
    isWifPoolOrProviderId(row.provider_id);
  const connection: ConnectionRecord = {
    connection_id: row.connection_id,
    account_id: row.c_account_id,
    provider: row.provider,
    // An incomplete provider reference can't be used: treat it as disabled.
    state: complete ? row.c_state : "incomplete",
    audience_test_passed: row.audience_test === "passed",
    provider_ref: {
      pool_project_number: `${row.pool_project_number ?? ""}`,
      pool_id: `${row.pool_id ?? ""}`,
      provider_id: `${row.provider_id ?? ""}`,
    },
  };
  return { grant, connection };
};

export const isAllowlisted: BrokerDeps["isAllowlisted"] = async (entry) => {
  const { rows } = await getPool().query(
    `SELECT 1 FROM federated_connector_allowlist
      WHERE provider = $1 AND service_account = $2
        AND permission_profile = $3 AND target_project = $4
      LIMIT 1`,
    [
      entry.provider,
      entry.service_account,
      entry.permission_profile,
      entry.target_project,
    ],
  );
  return rows.length === 1;
};

/** Appends a mint log row. The database sets its time. */
export async function recordMint(row: MintLogRow): Promise<void> {
  await getPool().query(
    `INSERT INTO federated_connector_mint_log
       (mint_id, outcome, reason, site_id, account_id, agent_id, project_id,
        host_id, run_id, connection_id, grant_id, grant_revision, lease_id,
        jti, key_version, service_account, issued_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15,
             CASE WHEN $16::BIGINT IS NULL THEN NULL
                  ELSE to_timestamp($16::BIGINT / 1000.0) END,
             CASE WHEN $17::BIGINT IS NULL THEN NULL
                  ELSE to_timestamp($17::BIGINT / 1000.0) END)`,
    [
      row.outcome,
      row.reason,
      row.site_id,
      row.account_id,
      row.agent_id,
      row.project_id,
      row.host_id,
      row.run_id,
      row.connection_id,
      row.grant_id,
      row.grant_revision,
      row.lease_id,
      row.jti,
      row.key_version,
      row.service_account,
      row.issued_at,
      row.expires_at,
    ],
  );
}

/**
 * Runs fn holding a transaction-scoped advisory lock for the lease, so one
 * exchange per lease is in flight across broker processes.
 */
export async function withLeaseLock<T>(
  lease_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 7172))",
      [`federated-lease:${lease_id}`],
    );
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
