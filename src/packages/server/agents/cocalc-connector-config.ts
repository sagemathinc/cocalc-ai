/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { CocalcConnectorConfig } from "@cocalc/conat/hub/api/agent";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { normalizeApiKeyScopeV1 } from "@cocalc/util/api-key-scope";
import { isValidUUID } from "@cocalc/util/misc";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { deleteClusterAccountApiKeyDirectoryEntry } from "@cocalc/server/inter-bay/accounts";
import {
  assertProjectFullCollaborator,
  assertScopeProjectsCollaborator,
} from "@cocalc/server/api/scope-project-access";
import { getIdentity } from "./api";

function accountIdForLocator({
  account_id,
  agent_id,
  source_project_id,
}: {
  account_id?: string;
  agent_id: string;
  source_project_id: string;
}): string {
  if (
    !account_id ||
    !isValidUUID(account_id) ||
    !isValidUUID(agent_id) ||
    !isValidUUID(source_project_id)
  ) {
    throw new Error("invalid CoCalc connector locator");
  }
  return account_id;
}

export async function assertAccountHome(account_id: string): Promise<void> {
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (location.home_bay_id !== getConfiguredBayId()) {
    throw new Error("CoCalc connector configuration is not on account home");
  }
}

async function assertNativeAgent({
  account_id,
  agent_id,
  source_project_id,
}: {
  account_id: string;
  agent_id: string;
  source_project_id: string;
}): Promise<void> {
  const identity = await getIdentity({
    account_id,
    agent_id,
    project_id: source_project_id,
  });
  if (identity.disabled_at || identity.project_id !== source_project_id) {
    throw new Error("native agent is unavailable");
  }
}

export async function getCocalcConnectorConfig({
  account_id,
  agent_id,
  source_project_id,
}: {
  account_id?: string;
  agent_id: string;
  source_project_id: string;
}): Promise<CocalcConnectorConfig | null> {
  const owner = accountIdForLocator({
    account_id,
    agent_id,
    source_project_id,
  });
  await assertAccountHome(owner);
  await assertProjectFullCollaborator({
    account_id: owner,
    project_id: source_project_id,
  });
  await assertNativeAgent({ account_id: owner, agent_id, source_project_id });
  const { rows } = await getPool().query<CocalcConnectorConfig>(
    `SELECT config_id,account_id,agent_id,source_project_id,scope,
            revision,enabled,created_at,updated_at
       FROM agent_cocalc_connector_configs
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3`,
    [owner, agent_id, source_project_id],
  );
  return rows[0] ?? null;
}

export async function saveCocalcConnectorConfig({
  account_id,
  session_hash,
  agent_id,
  source_project_id,
  expected_revision,
  scope,
  enabled,
}: {
  account_id?: string;
  session_hash?: string;
  agent_id: string;
  source_project_id: string;
  expected_revision?: number;
  scope: ApiKeyScope;
  enabled: boolean;
}): Promise<CocalcConnectorConfig> {
  const owner = accountIdForLocator({
    account_id,
    agent_id,
    source_project_id,
  });
  if (typeof enabled !== "boolean") throw new Error("invalid connector state");
  if (
    expected_revision !== undefined &&
    (!Number.isSafeInteger(expected_revision) || expected_revision < 1)
  ) {
    throw new Error("invalid connector revision");
  }
  await assertAccountHome(owner);
  await requireDangerousSessionAuth({
    account_id: owner,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  await assertProjectFullCollaborator({
    account_id: owner,
    project_id: source_project_id,
  });
  await assertNativeAgent({ account_id: owner, agent_id, source_project_id });
  // Disabled settings may retain an empty draft, but cannot issue a key.
  const canonical = normalizeApiKeyScopeV1(scope, { allowEmpty: !enabled });
  if (enabled) {
    await assertScopeProjectsCollaborator({
      account_id: owner,
      scope: canonical,
    });
  }
  const client = await getPool().connect();
  let result: CocalcConnectorConfig | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CocalcConnectorConfig>(
      `INSERT INTO agent_cocalc_connector_configs
       (config_id,account_id,agent_id,source_project_id,scope,enabled)
     VALUES($1,$2,$3,$4,$5::JSONB,$6)
     ON CONFLICT(account_id,agent_id,source_project_id)
     DO UPDATE SET scope=EXCLUDED.scope,enabled=EXCLUDED.enabled,
                   revision=agent_cocalc_connector_configs.revision+1,
                   updated_at=now()
       WHERE agent_cocalc_connector_configs.revision=$7
     RETURNING config_id,account_id,agent_id,source_project_id,scope,
               revision,enabled,created_at,updated_at`,
      [
        randomUUID(),
        owner,
        agent_id,
        source_project_id,
        JSON.stringify(canonical),
        enabled,
        expected_revision ?? null,
      ],
    );
    result = rows[0];
    if (!result) {
      throw new Error("CoCalc connector changed; reload before saving");
    }
    const { rows: active } = await client.query<{ key_id: string }>(
      `SELECT key_id FROM agent_cocalc_connector_turns
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
          AND ended_at IS NULL AND expires_at>now() FOR UPDATE`,
      [owner, agent_id, source_project_id],
    );
    for (const { key_id } of active) {
      await deleteClusterAccountApiKeyDirectoryEntry({
        key_id,
        account_id: owner,
        home_bay_id: getConfiguredBayId(),
      });
    }
    if (active.length) {
      await client.query(
        `UPDATE agent_cocalc_connector_turns
            SET ended_at=now(),secret_ciphertext=''
          WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
            AND ended_at IS NULL AND expires_at>now()`,
        [owner, agent_id, source_project_id],
      );
      await client.query(
        `DELETE FROM api_keys WHERE account_id=$1 AND key_id=ANY($2::TEXT[])`,
        [owner, active.map(({ key_id }) => key_id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return result;
}
