/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// CLI connectors (gh, cf): account connections, per-agent grants, and the
// short-lived tokens handed to each verified agent turn. Runs at the account's
// home bay. Plan: src/.agents/cli-connectors-github-cloudflare-plan-2026-10-05.md

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  CliConnection,
  CliConnectorGrant,
} from "@cocalc/conat/hub/api/agent";
import {
  CLI_CONNECTOR_INFO,
  isCliConnector,
  type CliConnector,
  type CliConnectorTurnToken,
} from "@cocalc/util/ai/cli-connectors";
import {
  createExternalCredential,
  getExternalCredentialById,
  listExternalCredentials,
  revokeExternalCredential,
  type ExternalCredentialSelector,
} from "@cocalc/server/external-credentials/store";
import {
  assertAccountHome,
  authorizeConfigChange,
} from "./cocalc-connector-config";
import { assertLiveTurn, assertTrustedSource } from "./cocalc-connector-turn";
import { verifyActiveAgentRun } from "./identity-routing";

// A pasted token has no provider expiry here; hosts renew every minute, so
// a turn never holds a delivery older than this.
const PASTED_TOKEN_DELIVERY_MS = 15 * 60_000;
const VERIFY_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS_PER_CONNECTOR = 10;

type ConnectionPayload = { version: 1; type: "token"; token: string };

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`invalid ${name}`);
  }
  return value;
}

function requireConnector(value: unknown): CliConnector {
  if (!isCliConnector(value)) throw Error("unknown CLI connector");
  return value;
}

function selector(
  account_id: string,
  connector: CliConnector,
): ExternalCredentialSelector {
  const { provider, kind } = CLI_CONNECTOR_INFO[connector];
  return { provider, kind, scope: "account", owner_account_id: account_id };
}

function parsePayload(payload: string): ConnectionPayload {
  let value: any;
  try {
    value = JSON.parse(payload);
  } catch {
    throw Error("invalid CLI connection");
  }
  if (
    value?.version !== 1 ||
    value.type !== "token" ||
    typeof value.token !== "string"
  ) {
    throw Error("invalid CLI connection");
  }
  return value;
}

function validToken(token: unknown): string {
  const value = typeof token === "string" ? token.trim() : "";
  if (value.length < 10 || value.length > 4096 || /\s/.test(value)) {
    throw Error("That does not look like an API token");
  }
  return value;
}

type Fetch = typeof globalThis.fetch;

/** Who a token belongs to, checked with the provider before it is saved. */
export async function describeToken(
  connector: CliConnector,
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<string> {
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  if (connector === "github") {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "CoCalc",
      },
      signal,
    });
    if (!response.ok) throw Error("GitHub did not accept this token");
    const user = (await response.json()) as { login?: unknown };
    if (typeof user.login !== "string" || !user.login) {
      throw Error("GitHub did not accept this token");
    }
    return `@${user.login}`;
  }
  const response = await fetchImpl(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    { headers: { authorization: `Bearer ${token}` }, signal },
  );
  const body = (await response.json().catch(() => undefined)) as
    | { success?: boolean; result?: { status?: string } }
    | undefined;
  if (!response.ok || body?.success !== true) {
    throw Error("Cloudflare did not accept this token");
  }
  if (body.result?.status && body.result.status !== "active") {
    throw Error(`This Cloudflare token is ${body.result.status}`);
  }
  return "API token";
}

export async function listCliConnections({
  account_id,
}: {
  account_id?: string;
}): Promise<CliConnection[]> {
  const owner = requireUuid(account_id, "account_id");
  await assertAccountHome(owner);
  const result: CliConnection[] = [];
  for (const connector of Object.keys(CLI_CONNECTOR_INFO) as CliConnector[]) {
    const { provider, kind } = CLI_CONNECTOR_INFO[connector];
    for (const row of await listExternalCredentials({
      owner_account_id: owner,
      provider,
      kind,
      scope: "account",
    })) {
      result.push({
        connection_id: row.id,
        connector,
        description: `${row.metadata?.description ?? ""}`,
        created: row.created,
        last_used: row.last_used,
      });
    }
  }
  return result;
}

/** Save a pasted token as a connection, after the provider accepts it. */
export async function connectCliToken({
  account_id,
  session_hash,
  connector: connectorInput,
  token: tokenInput,
  fetchImpl,
}: {
  account_id?: string;
  session_hash?: string;
  connector: string;
  token: string;
  fetchImpl?: Fetch;
}): Promise<CliConnection> {
  const owner = requireUuid(account_id, "account_id");
  const connector = requireConnector(connectorInput);
  const token = validToken(tokenInput);
  await assertAccountHome(owner);
  const { requireDangerousSessionAuth } =
    await import("@cocalc/server/conat/api/dangerous-session-auth");
  await requireDangerousSessionAuth({
    account_id: owner,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  const description = await describeToken(connector, token, fetchImpl);
  const payload: ConnectionPayload = { version: 1, type: "token", token };
  const { id } = await createExternalCredential({
    selector: selector(owner, connector),
    payload: JSON.stringify(payload),
    metadata: { description, connector, source: "pasted-token" },
    maxActive: MAX_CONNECTIONS_PER_CONNECTOR,
  });
  return {
    connection_id: id,
    connector,
    description,
    created: new Date(),
    last_used: null,
  };
}

/** Remove a connection and turn off every agent grant that used it. */
export async function disconnectCliConnection({
  account_id,
  connection_id,
}: {
  account_id?: string;
  connection_id: string;
}): Promise<void> {
  const owner = requireUuid(account_id, "account_id");
  const id = requireUuid(connection_id, "connection_id");
  await assertAccountHome(owner);
  // Only CLI connections: never another kind of credential of this account.
  const found = await Promise.all(
    (Object.keys(CLI_CONNECTOR_INFO) as CliConnector[]).map((connector) =>
      getExternalCredentialById({
        id,
        selector: selector(owner, connector),
        touchLastUsed: false,
      }),
    ),
  );
  if (!found.some(Boolean)) throw Error("connection is unavailable");
  // Stopping access never needs fresh authentication.
  await getPool().query(
    `UPDATE agent_connector_grants
        SET enabled=false, connection_id=NULL, revision=revision+1, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2`,
    [owner, id],
  );
  await revokeExternalCredential({ id, owner_account_id: owner });
}

export async function listCliConnectorGrants({
  account_id,
  agent_id,
  source_project_id,
}: {
  account_id?: string;
  agent_id?: string;
  source_project_id?: string;
}): Promise<CliConnectorGrant[]> {
  const owner = requireUuid(account_id, "account_id");
  if (agent_id !== undefined) requireUuid(agent_id, "agent_id");
  if (source_project_id !== undefined) {
    requireUuid(source_project_id, "source_project_id");
  }
  await assertAccountHome(owner);
  const { rows } = await getPool().query<CliConnectorGrant>(
    `SELECT grant_id,account_id,agent_id,source_project_id,connector,
            connection_id,scope,revision,enabled,created_at,updated_at
       FROM agent_connector_grants
      WHERE account_id=$1
        AND ($2::uuid IS NULL OR agent_id=$2::uuid)
        AND ($3::uuid IS NULL OR source_project_id=$3::uuid)
      ORDER BY updated_at DESC
      LIMIT 1000`,
    [owner, agent_id ?? null, source_project_id ?? null],
  );
  return rows;
}

/**
 * Turn a connector on or off for one agent. Turning it on needs fresh
 * authentication and a connection the account owns; turning it off is a
 * narrowing and needs neither. Compare-and-swap on the revision.
 */
export async function saveCliConnectorGrant({
  account_id,
  session_hash,
  agent_id,
  source_project_id,
  connector: connectorInput,
  connection_id,
  enabled,
  expected_revision,
}: {
  account_id?: string;
  session_hash?: string;
  agent_id: string;
  source_project_id: string;
  connector: string;
  connection_id?: string | null;
  enabled: boolean;
  expected_revision?: number;
}): Promise<CliConnectorGrant> {
  const owner = requireUuid(account_id, "account_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  const connector = requireConnector(connectorInput);
  if (typeof enabled !== "boolean") throw Error("invalid connector state");
  if (
    expected_revision !== undefined &&
    (!Number.isSafeInteger(expected_revision) || expected_revision < 1)
  ) {
    throw Error("invalid grant revision");
  }
  if (enabled) {
    requireUuid(connection_id, "connection_id");
    await authorizeConfigChange({
      account_id: owner,
      session_hash,
      agent_id,
      source_project_id,
    });
    const connection = await getExternalCredentialById({
      id: connection_id!,
      selector: selector(owner, connector),
      touchLastUsed: false,
    });
    if (!connection) throw Error("connection is unavailable");
  } else {
    await assertAccountHome(owner);
  }
  const { rows } = await getPool().query<CliConnectorGrant>(
    `INSERT INTO agent_connector_grants
       (grant_id,account_id,agent_id,source_project_id,connector,
        connection_id,scope,revision,enabled,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'{}'::JSONB,1,$7,now(),now())
     ON CONFLICT (account_id,agent_id,source_project_id,connector) DO UPDATE
       SET connection_id=COALESCE(EXCLUDED.connection_id,
                                  agent_connector_grants.connection_id),
           enabled=EXCLUDED.enabled,
           revision=agent_connector_grants.revision+1,
           updated_at=now()
     WHERE $8::integer IS NULL OR agent_connector_grants.revision=$8::integer
     RETURNING grant_id,account_id,agent_id,source_project_id,connector,
               connection_id,scope,revision,enabled,created_at,updated_at`,
    [
      randomUUID(),
      owner,
      agent_id,
      source_project_id,
      connector,
      enabled ? connection_id : null,
      enabled,
      expected_revision ?? null,
    ],
  );
  if (!rows[0]) throw Error("connector settings changed; reload and try again");
  return rows[0];
}

/**
 * Tokens for one verified agent turn: one per enabled grant whose connection
 * still exists. Refresh tokens and connection payloads never leave the hub.
 */
export type { CliConnection, CliConnectorGrant };

export async function issueCliConnectorTurnTokens({
  account_id,
  host_id,
  agent_id,
  source_project_id,
  run_id,
  turn_ref,
  now = Date.now(),
}: {
  account_id?: string;
  host_id?: string;
  agent_id: string;
  source_project_id: string;
  run_id: string;
  turn_ref: {
    chat_path: string;
    message_date: string;
    message_id: string;
    thread_id: string;
  };
  now?: number;
}): Promise<CliConnectorTurnToken[]> {
  const owner = requireUuid(account_id, "account_id");
  const host = requireUuid(host_id, "host_id");
  requireUuid(agent_id, "agent_id");
  requireUuid(source_project_id, "source_project_id");
  requireUuid(run_id, "run_id");
  await assertTrustedSource({
    account_id: owner,
    host_id: host,
    source_project_id,
  });
  const grants = (
    await listCliConnectorGrants({
      account_id: owner,
      agent_id,
      source_project_id,
    })
  ).filter((grant) => grant.enabled && grant.connection_id);
  if (grants.length === 0) return [];
  await verifyActiveAgentRun({
    account_id: owner,
    agent_id,
    project_id: source_project_id,
    run_id,
  });
  await assertLiveTurn({
    account_id: owner,
    host_id: host,
    source_project_id,
    agent_id,
    turn: turn_ref,
  });
  const tokens: CliConnectorTurnToken[] = [];
  for (const grant of grants) {
    if (!isCliConnector(grant.connector)) continue;
    const connection = await getExternalCredentialById({
      id: grant.connection_id!,
      selector: selector(owner, grant.connector),
    });
    if (!connection) continue;
    const payload = parsePayload(connection.payload);
    tokens.push({
      connector: grant.connector,
      token: payload.token,
      expires_at: now + PASTED_TOKEN_DELIVERY_MS,
      description: `${connection.metadata?.description ?? ""}`,
    });
  }
  return tokens;
}
