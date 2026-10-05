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
  CliConnectorSetup,
  CliConnectorSignIn,
  CliConnectorSignInStatus,
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
  updateExternalCredentialPayloadLocked,
  type ExternalCredentialSelector,
} from "@cocalc/server/external-credentials/store";
import {
  getGithubConnectorConfig,
  GithubReconnectRequired,
  pollGithubDeviceLogin,
  refreshGithubConnection,
  revokeGithubToken,
  startGithubDeviceLogin,
  type GithubAppConnection,
  type GithubDeviceLogin,
} from "./cli-connector-github";
import {
  EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY,
  GITHUB_DEVICE_LOGIN_KIND,
} from "@cocalc/server/external-credentials/provider-policy";
import {
  assertAccountHome,
  authorizeConfigChange,
} from "./cocalc-connector-config";
import { assertLiveTurn, assertTrustedSource } from "./cocalc-connector-turn";
import { verifyActiveAgentRun } from "./identity-routing";

const MAX_CONNECTIONS_PER_CONNECTOR = 10;
const MAX_PENDING_SIGN_INS = 3;
// Below the list limit, so every grant stays visible and revocable.
const MAX_GRANTS_PER_ACCOUNT = 500;

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

function parseJson(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function parseGithubConnection(
  payload: string,
): GithubAppConnection | undefined {
  const value = parseJson(payload);
  return value?.version === 2 && value.type === "github-app"
    ? value
    : undefined;
}

function pendingSelector(account_id: string): ExternalCredentialSelector {
  return {
    provider: "github",
    kind: GITHUB_DEVICE_LOGIN_KIND,
    scope: "account",
    owner_account_id: account_id,
  };
}

type Fetch = typeof globalThis.fetch;

/** Which connectors this site has set up (no secrets). */
export async function getCliConnectorSetup({
  account_id,
}: {
  account_id?: string;
}): Promise<CliConnectorSetup> {
  requireUuid(account_id, "account_id");
  const github = await getGithubConnectorConfig();
  return {
    github: { available: !!github, app_url: github?.app_url || undefined },
    cloudflare: { available: false },
  };
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
        ...(row.metadata?.needs_reconnect ? { needs_reconnect: true } : {}),
      });
    }
  }
  return result;
}

/**
 * Start signing in to a connector's provider (fresh authentication): the user
 * approves the returned code at the provider, then the browser polls.
 */
export async function startCliConnectorSignIn({
  account_id,
  session_hash,
  connector: connectorInput,
  fetchImpl,
}: {
  account_id?: string;
  session_hash?: string;
  connector: string;
  fetchImpl?: Fetch;
}): Promise<CliConnectorSignIn> {
  const owner = requireUuid(account_id, "account_id");
  const connector = requireConnector(connectorInput);
  await assertAccountHome(owner);
  const config =
    connector === "github" ? await getGithubConnectorConfig() : undefined;
  if (!config) {
    throw Error(
      `${CLI_CONNECTOR_INFO[connector].label} is not set up on this site`,
    );
  }
  const { requireDangerousSessionAuth } =
    await import("@cocalc/server/conat/api/dangerous-session-auth");
  await requireDangerousSessionAuth({
    account_id: owner,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  const started = await startGithubDeviceLogin({ config, fetchImpl });
  const { id } = await createExternalCredential({
    selector: pendingSelector(owner),
    payload: JSON.stringify(started.login),
    metadata: {
      connector,
      [EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY]: new Date(
        started.login.expires_at,
      ).toISOString(),
    },
    maxActive: MAX_PENDING_SIGN_INS,
  });
  return {
    login_id: id,
    connector,
    user_code: started.user_code,
    verification_uri: started.verification_uri,
    interval: started.interval,
    expires_at: started.login.expires_at,
  };
}

/** Finish a sign-in once the user approved it at the provider. */
export async function pollCliConnectorSignIn({
  account_id,
  login_id,
  fetchImpl,
}: {
  account_id?: string;
  login_id: string;
  fetchImpl?: Fetch;
}): Promise<CliConnectorSignInStatus> {
  const owner = requireUuid(account_id, "account_id");
  const id = requireUuid(login_id, "login_id");
  await assertAccountHome(owner);
  const pending = await getExternalCredentialById({
    id,
    selector: pendingSelector(owner),
    touchLastUsed: false,
  });
  const login = pending
    ? (parseJson(pending.payload) as GithubDeviceLogin)
    : undefined;
  if (!login || login.type !== "github-device-login") {
    return { status: "expired" };
  }
  const config = await getGithubConnectorConfig();
  const finish = () =>
    revokeExternalCredential({ id, owner_account_id: owner });
  if (!config) {
    await finish();
    return { status: "expired" };
  }
  const result = await pollGithubDeviceLogin({ config, login, fetchImpl });
  if (result.status === "pending") return result;
  await finish();
  if (result.status !== "connected") return result;
  const description = `@${result.login}`;
  const { id: connection_id } = await createExternalCredential({
    selector: selector(owner, "github"),
    payload: JSON.stringify(result.connection),
    metadata: { description, connector: "github", source: "github-app" },
    maxActive: MAX_CONNECTIONS_PER_CONNECTOR,
  });
  return {
    status: "connected",
    connection: {
      connection_id,
      connector: "github",
      description,
      created: new Date(),
      last_used: null,
    },
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
  const connection = found.find(Boolean);
  if (!connection) throw Error("connection is unavailable");
  // Stopping access never needs fresh authentication.
  await getPool().query(
    `UPDATE agent_connector_grants
        SET enabled=false, connection_id=NULL, revision=revision+1, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2`,
    [owner, id],
  );
  await revokeExternalCredential({ id, owner_account_id: owner });
  // Also invalidate the token at GitHub, best effort: CoCalc's copy is gone.
  const github = parseGithubConnection(connection.payload);
  const config = github ? await getGithubConnectorConfig() : undefined;
  if (github && config && github.client_id === config.client_id) {
    await revokeGithubToken({ config, token: github.access_token }).catch(
      () => undefined,
    );
  }
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
  if (!enabled) {
    // Turning off narrows access, so it needs no fresh authentication, but
    // it only changes a grant that exists, at the revision the user saw.
    await assertAccountHome(owner);
    if (expected_revision === undefined) throw Error("invalid grant revision");
    const { rows } = await getPool().query<CliConnectorGrant>(
      `UPDATE agent_connector_grants
          SET enabled=false, revision=revision+1, updated_at=now()
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
          AND connector=$4 AND revision=$5
        RETURNING grant_id,account_id,agent_id,source_project_id,connector,
                  connection_id,scope,revision,enabled,created_at,updated_at`,
      [owner, agent_id, source_project_id, connector, expected_revision],
    );
    if (!rows[0]) {
      throw Error("connector settings changed; reload and try again");
    }
    return rows[0];
  }
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
  // The account-scoped lock makes the count and the insert one step, so
  // concurrent first writes cannot exceed the bound.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('agent_connector_grants:' || $1, 0))",
      [owner],
    );
    if (expected_revision === undefined) {
      const { rows: counted } = await client.query<{ count: string }>(
        `SELECT count(*) FROM agent_connector_grants WHERE account_id=$1`,
        [owner],
      );
      if (Number(counted[0]?.count ?? 0) >= MAX_GRANTS_PER_ACCOUNT) {
        throw Error("too many agents have connector settings");
      }
    }
    // A new grant needs no revision; changing one needs the revision the user
    // saw (a missing one never matches).
    const { rows } = await client.query<CliConnectorGrant>(
      `INSERT INTO agent_connector_grants
         (grant_id,account_id,agent_id,source_project_id,connector,
          connection_id,scope,revision,enabled,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'{}'::JSONB,1,$7,now(),now())
       ON CONFLICT (account_id,agent_id,source_project_id,connector) DO UPDATE
         SET connection_id=EXCLUDED.connection_id,
             enabled=true,
             revision=agent_connector_grants.revision+1,
             updated_at=now()
       WHERE agent_connector_grants.revision=$8::integer
       RETURNING grant_id,account_id,agent_id,source_project_id,connector,
                 connection_id,scope,revision,enabled,created_at,updated_at`,
      [
        randomUUID(),
        owner,
        agent_id,
        source_project_id,
        connector,
        connection_id,
        true,
        expected_revision ?? null,
      ],
    );
    if (!rows[0]) {
      throw Error("connector settings changed; reload and try again");
    }
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
  fetchImpl,
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
  fetchImpl?: Fetch;
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
  // Read the grants again and the tokens under a share lock, so a concurrent
  // turn-off or disconnect (which update these rows) is ordered entirely
  // before or after this issuance, never in between.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query<CliConnectorGrant>(
      `SELECT grant_id,connector,connection_id
         FROM agent_connector_grants
        WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
          AND enabled AND connection_id IS NOT NULL
        FOR SHARE`,
      [owner, agent_id, source_project_id],
    );
    const tokens: CliConnectorTurnToken[] = [];
    for (const grant of locked) {
      if (grant.connector !== "github") continue;
      const token = await githubTurnToken({
        owner,
        connection_id: grant.connection_id!,
        now,
        fetchImpl,
      });
      if (token) tokens.push(token);
    }
    await client.query("COMMIT");
    return tokens;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A GitHub access token for one turn, refreshed under the connection's lock
 * when it is close to expiry. A connection GitHub refuses to refresh is
 * marked for reconnecting and gives no token.
 */
async function githubTurnToken({
  owner,
  connection_id,
  now,
  fetchImpl,
}: {
  owner: string;
  connection_id: string;
  now: number;
  fetchImpl?: Fetch;
}): Promise<CliConnectorTurnToken | undefined> {
  const config = await getGithubConnectorConfig();
  if (!config) return;
  let current: GithubAppConnection | undefined;
  const updated = await updateExternalCredentialPayloadLocked({
    selector: selector(owner, "github"),
    id: connection_id,
    update: async (credential) => {
      const connection = parseGithubConnection(credential.payload);
      if (!connection || credential.metadata?.needs_reconnect) return;
      try {
        const result = await refreshGithubConnection({
          config,
          connection,
          now,
          fetchImpl,
        });
        current = result.connection;
        return result.refreshed
          ? { payload: JSON.stringify(result.connection) }
          : undefined;
      } catch (err) {
        if (!(err instanceof GithubReconnectRequired)) throw err;
        return {
          payload: credential.payload,
          metadata: { ...credential.metadata, needs_reconnect: true },
        };
      }
    },
  });
  if (!updated || !current) return;
  return {
    connector: "github",
    token: current.access_token,
    expires_at: current.access_expires_at,
    description: `${updated.metadata?.description ?? ""}`,
  };
}
