/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomBytes, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { normalizeApiKeyScopeV1 } from "@cocalc/util/api-key-scope";
import { isValidUUID } from "@cocalc/util/misc";
import { assertAccountProjectHostTokenProjectAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import {
  createApiKeySecret,
  ensureApiKeysV2Schema,
  syncAccountApiKeyDirectory,
} from "@cocalc/server/api/manage";
import {
  deleteClusterAccountApiKeyDirectoryEntry,
  getClusterAccountById,
} from "@cocalc/server/inter-bay/accounts";
import {
  assertProjectFullCollaborator,
  assertScopeProjectsCollaborator,
} from "@cocalc/server/api/scope-project-access";
import { recordApiKeyAuditEvent } from "@cocalc/server/api/api-key-audit";
import { verifyActiveAgentRun } from "./identity-routing";
import { assertAccountHome } from "./cocalc-connector-config";

const MANAGED_KEY_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_MANAGED_KEYS_PER_ACCOUNT = 64;
const MAX_NEW_MANAGED_KEYS_PER_MINUTE = 60;
const MAX_NEW_MANAGED_KEYS_PER_TEN_SECONDS = 10;

interface SavedConfig {
  config_id: string;
  scope: ApiKeyScope;
  revision: number;
  enabled: boolean;
}

interface ManagedTurnRow {
  turn_id: string;
  source_host_id: string;
  config_id: string;
  config_revision: number;
  key_id: string;
  secret_ciphertext: string;
  expires_at: Date;
  ended_at: Date | null;
  account_id?: string;
  agent_id?: string;
  source_project_id?: string;
  run_id?: string;
  renewed_at?: Date;
}

interface KeyRow {
  id: number;
  key_id: string;
  hash: string;
  scope: ApiKeyScope;
  scope_revision: number;
  expire: Date;
}

export interface ManagedCocalcConnectorKey {
  turn_id: string;
  key_id: string;
  secret: string;
  expires_at: number;
  config_id: string;
  config_revision: number;
}

function requireUuid(value: string | undefined, name: string): string {
  if (!value || !isValidUUID(value)) throw Error(`invalid ${name}`);
  return value;
}

function secretName(turn_id: string): string {
  return `agent-cocalc-connector-turn:${turn_id}`;
}

async function assertTrustedSource({
  account_id,
  host_id,
  source_project_id,
}: {
  account_id: string;
  host_id: string;
  source_project_id: string;
}): Promise<void> {
  await assertAccountHome(account_id);
  await assertAccountProjectHostTokenProjectAccess({
    account_id,
    host_id,
    project_id: source_project_id,
  });
  await assertProjectFullCollaborator({
    account_id,
    project_id: source_project_id,
  });
}

async function currentConfig({
  account_id,
  agent_id,
  source_project_id,
}: {
  account_id: string;
  agent_id: string;
  source_project_id: string;
}): Promise<SavedConfig | undefined> {
  const { rows } = await getPool().query<SavedConfig>(
    `SELECT config_id,scope,revision,enabled
       FROM agent_cocalc_connector_configs
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3`,
    [account_id, agent_id, source_project_id],
  );
  return rows[0];
}

export async function beginManagedCocalcConnectorTurn({
  account_id,
  host_id,
  agent_id,
  source_project_id,
  run_id,
  idempotency_key,
}: {
  account_id?: string;
  host_id?: string;
  agent_id: string;
  source_project_id: string;
  run_id: string;
  idempotency_key: string;
}): Promise<ManagedCocalcConnectorKey | undefined> {
  const owner = requireUuid(account_id, "account_id");
  const host = requireUuid(host_id, "host_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  requireUuid(run_id, "run_id");
  requireUuid(idempotency_key, "idempotency_key");
  await assertTrustedSource({
    account_id: owner,
    host_id: host,
    source_project_id,
  });
  const config = await currentConfig({
    account_id: owner,
    agent_id,
    source_project_id,
  });
  if (!config?.enabled) return;
  await verifyActiveAgentRun({
    account_id: owner,
    agent_id,
    project_id: source_project_id,
    run_id,
  });
  await assertAccountTrustedForProductAccess(owner, "create API keys");
  const scope = normalizeApiKeyScopeV1(config.scope);
  await assertScopeProjectsCollaborator({ account_id: owner, scope });
  await ensureApiKeysV2Schema();

  const turn_id = randomUUID();
  const key_id = randomBytes(12).toString("base64url");
  const secret = createApiKeySecret({ key_id });
  const hash = passwordHash(secret);
  const ciphertext = await encryptSecretStorageValue(
    secretName(turn_id),
    secret,
  );
  const expiresAt = new Date(Date.now() + MANAGED_KEY_TTL_MS);
  const client = await getPool().connect();
  let result:
    | { turn: ManagedTurnRow; key: KeyRow; created: boolean }
    | undefined;
  try {
    await client.query("BEGIN");
    // Serialize all managed issuance for this account, including across agents.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [owner]);
    const { rows: configs } = await client.query<SavedConfig>(
      `SELECT config_id,scope,revision,enabled
         FROM agent_cocalc_connector_configs
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
        FOR UPDATE`,
      [owner, agent_id, source_project_id],
    );
    const locked = configs[0];
    if (
      !locked?.enabled ||
      locked.config_id !== config.config_id ||
      locked.revision !== config.revision ||
      JSON.stringify(normalizeApiKeyScopeV1(locked.scope)) !==
        JSON.stringify(scope)
    ) {
      throw Error("CoCalc connector configuration changed during issuance");
    }
    const { rows: turns } = await client.query<ManagedTurnRow>(
      `SELECT turn_id,source_host_id,config_id,config_revision,key_id,
              secret_ciphertext,expires_at,ended_at
         FROM agent_cocalc_connector_turns
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
          AND run_id=$4 AND idempotency_key=$5
        FOR UPDATE`,
      [owner, agent_id, source_project_id, run_id, idempotency_key],
    );
    if (turns[0]) {
      const turn = turns[0];
      if (
        turn.ended_at ||
        new Date(turn.expires_at).valueOf() <= Date.now() ||
        turn.source_host_id !== host ||
        turn.config_id !== config.config_id ||
        turn.config_revision !== config.revision
      ) {
        throw Error("managed CoCalc connector turn is no longer valid");
      }
      const { rows: keys } = await client.query<KeyRow>(
        `SELECT id,key_id,hash,scope,scope_revision,expire
           FROM api_keys WHERE account_id=$1 AND key_id=$2`,
        [owner, turn.key_id],
      );
      const key = keys[0];
      if (
        !key ||
        key.scope_revision !== 1 ||
        new Date(key.expire).valueOf() <= Date.now() ||
        JSON.stringify(normalizeApiKeyScopeV1(key.scope)) !==
          JSON.stringify(scope)
      ) {
        throw Error("managed CoCalc connector key was changed or revoked");
      }
      result = { turn, key, created: false };
    } else {
      const { rows: budget } = await client.query<{
        active: string;
        recent_minute: string;
        recent_burst: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE ended_at IS NULL AND expires_at>now()) AS active,
           COUNT(*) FILTER (WHERE created_at>now()-interval '1 minute') AS recent_minute,
           COUNT(*) FILTER (WHERE created_at>now()-interval '10 seconds') AS recent_burst
         FROM agent_cocalc_connector_turns WHERE account_id=$1`,
        [owner],
      );
      if (
        Number(budget[0]?.active) >= MAX_ACTIVE_MANAGED_KEYS_PER_ACCOUNT ||
        Number(budget[0]?.recent_minute) >= MAX_NEW_MANAGED_KEYS_PER_MINUTE ||
        Number(budget[0]?.recent_burst) >= MAX_NEW_MANAGED_KEYS_PER_TEN_SECONDS
      ) {
        throw Error("managed CoCalc connector key limit reached");
      }
      const { rows: keys } = await client.query<KeyRow>(
        `INSERT INTO api_keys
          (account_id,created,expire,name,key_id,hash,trunc,
           capabilities,allowed_project_ids,scope)
         VALUES($1,now(),$2,$3,$4,$5,$6,'{}'::TEXT[],'{}'::UUID[],$7::JSONB)
         RETURNING id,key_id,hash,scope,scope_revision,expire`,
        [
          owner,
          expiresAt,
          "CoCalc connector turn",
          key_id,
          hash,
          `${secret.slice(0, 5)}...${secret.slice(-8)}`,
          JSON.stringify(scope),
        ],
      );
      const { rows: created } = await client.query<ManagedTurnRow>(
        `INSERT INTO agent_cocalc_connector_turns
          (turn_id,account_id,agent_id,source_project_id,source_host_id,
           run_id,idempotency_key,config_id,config_revision,key_id,
           secret_ciphertext,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING turn_id,source_host_id,config_id,config_revision,key_id,
                   secret_ciphertext,expires_at,ended_at`,
        [
          turn_id,
          owner,
          agent_id,
          source_project_id,
          host,
          run_id,
          idempotency_key,
          config.config_id,
          config.revision,
          key_id,
          ciphertext,
          expiresAt,
        ],
      );
      result = { turn: created[0], key: keys[0], created: true };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!result?.turn || !result.key) {
    throw Error("managed CoCalc connector issuance was incomplete");
  }
  const resolvedSecret = result.created
    ? secret
    : (
        await decryptSecretStorageValue(
          secretName(result.turn.turn_id),
          result.turn.secret_ciphertext,
        )
      ).value;
  if (
    !resolvedSecret ||
    !result.key.hash ||
    !verifyPassword(resolvedSecret, result.key.hash)
  ) {
    throw Error("managed CoCalc connector credential is unavailable");
  }
  await syncAccountApiKeyDirectory({
    account_id: owner,
    key_id: result.key.key_id,
    hash: result.key.hash,
    capabilities: [],
    allowed_project_ids: [],
    scope,
    scope_revision: result.key.scope_revision,
    expire: result.key.expire,
  });
  if (result.created) {
    await recordApiKeyAuditEvent({
      event: "api_key_created",
      value: {
        account_id: owner,
        api_key_id: result.key.id,
        key_id: result.key.key_id,
        source: "agent-cocalc-connector",
      },
    });
  }
  return {
    turn_id: result.turn.turn_id,
    key_id: result.key.key_id,
    secret: resolvedSecret,
    expires_at: new Date(result.turn.expires_at).valueOf(),
    config_id: result.turn.config_id,
    config_revision: result.turn.config_revision,
  };
}

export async function renewManagedCocalcConnectorTurn({
  account_id,
  host_id,
  agent_id,
  source_project_id,
  run_id,
  turn_id,
}: {
  account_id?: string;
  host_id?: string;
  agent_id: string;
  source_project_id: string;
  run_id: string;
  turn_id: string;
}): Promise<number> {
  const owner = requireUuid(account_id, "account_id");
  const host = requireUuid(host_id, "host_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  requireUuid(run_id, "run_id");
  requireUuid(turn_id, "turn_id");
  await assertTrustedSource({
    account_id: owner,
    host_id: host,
    source_project_id,
  });
  await verifyActiveAgentRun({
    account_id: owner,
    agent_id,
    project_id: source_project_id,
    run_id,
  });
  const config = await currentConfig({
    account_id: owner,
    agent_id,
    source_project_id,
  });
  if (!config?.enabled) throw Error("CoCalc connector is disabled");
  const scope = normalizeApiKeyScopeV1(config.scope);
  await assertScopeProjectsCollaborator({ account_id: owner, scope });

  const client = await getPool().connect();
  let key: KeyRow | undefined;
  let expiresAt: Date | undefined;
  try {
    await client.query("BEGIN");
    const { rows: turns } = await client.query<ManagedTurnRow>(
      `SELECT account_id,agent_id,source_project_id,source_host_id,run_id,
              config_id,config_revision,key_id,expires_at,ended_at,renewed_at
         FROM agent_cocalc_connector_turns WHERE turn_id=$1 FOR UPDATE`,
      [turn_id],
    );
    const turn = turns[0];
    if (
      !turn ||
      turn.account_id !== owner ||
      turn.agent_id !== agent_id ||
      turn.source_project_id !== source_project_id ||
      turn.source_host_id !== host ||
      turn.run_id !== run_id ||
      turn.config_id !== config.config_id ||
      turn.config_revision !== config.revision ||
      turn.ended_at ||
      new Date(turn.expires_at).valueOf() <= Date.now()
    ) {
      throw Error("managed CoCalc connector turn is no longer valid");
    }
    const { rows: keys } = await client.query<KeyRow>(
      `SELECT id,key_id,hash,scope,scope_revision,expire
         FROM api_keys WHERE account_id=$1 AND key_id=$2 FOR UPDATE`,
      [owner, turn.key_id],
    );
    key = keys[0];
    if (
      !key ||
      key.scope_revision !== 1 ||
      new Date(key.expire).valueOf() <= Date.now() ||
      JSON.stringify(normalizeApiKeyScopeV1(key.scope)) !==
        JSON.stringify(scope)
    ) {
      throw Error("managed CoCalc connector key was changed or revoked");
    }
    const renewedAt = turn.renewed_at ? new Date(turn.renewed_at).valueOf() : 0;
    if (renewedAt > Date.now() - 30_000) {
      expiresAt = new Date(turn.expires_at);
    } else {
      expiresAt = new Date(Date.now() + MANAGED_KEY_TTL_MS);
      const keyUpdate = await client.query(
        `UPDATE api_keys SET expire=$3
          WHERE account_id=$1 AND key_id=$2 AND expire>now()
            AND scope_revision=1`,
        [owner, turn.key_id, expiresAt],
      );
      if (keyUpdate.rowCount !== 1) {
        throw Error("managed CoCalc connector key expired during renewal");
      }
      const turnUpdate = await client.query(
        `UPDATE agent_cocalc_connector_turns
            SET expires_at=$2,renewed_at=now()
          WHERE turn_id=$1 AND ended_at IS NULL AND expires_at>now()`,
        [turn_id, expiresAt],
      );
      if (turnUpdate.rowCount !== 1) {
        throw Error("managed CoCalc connector turn expired during renewal");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!key || !expiresAt) throw Error("managed key renewal was incomplete");
  await syncAccountApiKeyDirectory({
    account_id: owner,
    key_id: key.key_id,
    hash: key.hash,
    capabilities: [],
    allowed_project_ids: [],
    scope,
    scope_revision: key.scope_revision,
    expire: expiresAt,
  });
  return expiresAt.valueOf();
}

export async function endManagedCocalcConnectorTurn({
  account_id,
  host_id,
  agent_id,
  source_project_id,
  run_id,
  turn_id,
}: {
  account_id?: string;
  host_id?: string;
  agent_id: string;
  source_project_id: string;
  run_id: string;
  turn_id: string;
}): Promise<void> {
  const owner = requireUuid(account_id, "account_id");
  const host = requireUuid(host_id, "host_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  requireUuid(run_id, "run_id");
  requireUuid(turn_id, "turn_id");
  await assertAccountHome(owner);
  const account = await getClusterAccountById(owner);
  const homeBay = `${account?.home_bay_id ?? ""}`.trim();
  if (!homeBay) {
    throw Error("unable to resolve account home for connector revocation");
  }
  const client = await getPool().connect();
  let keyId: string | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ManagedTurnRow>(
      `SELECT account_id,agent_id,source_project_id,source_host_id,run_id,
              key_id,ended_at
         FROM agent_cocalc_connector_turns WHERE turn_id=$1 FOR UPDATE`,
      [turn_id],
    );
    const turn = rows[0];
    if (
      !turn ||
      turn.account_id !== owner ||
      turn.agent_id !== agent_id ||
      turn.source_project_id !== source_project_id ||
      turn.source_host_id !== host ||
      turn.run_id !== run_id
    ) {
      throw Error("managed CoCalc connector turn does not match caller");
    }
    keyId = turn.key_id;
    if (!turn.ended_at) {
      await client.query(
        `UPDATE agent_cocalc_connector_turns
            SET ended_at=now(),secret_ciphertext='' WHERE turn_id=$1`,
        [turn_id],
      );
      await client.query(
        "DELETE FROM api_keys WHERE account_id=$1 AND key_id=$2",
        [owner, keyId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await deleteClusterAccountApiKeyDirectoryEntry({
    key_id: keyId!,
    account_id: owner,
    home_bay_id: homeBay,
  });
  await recordApiKeyAuditEvent({
    event: "api_key_deleted",
    value: {
      account_id: owner,
      key_id: keyId,
      source: "agent-cocalc-connector",
    },
  });
}
