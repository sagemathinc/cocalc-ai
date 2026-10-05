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
  sanitizeConnectionDescription,
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
  githubLogin,
  refreshGithubConnection,
  revokeGithubToken,
  startGithubDeviceLogin,
  type GithubAppConnection,
  type GithubConnectorConfig,
  type GithubDeviceLogin,
} from "./cli-connector-github";
import {
  cloudflareEmail,
  CloudflareReconnectRequired,
  getCloudflareConnectorConfig,
  pollCloudflareDeviceLogin,
  presetLabels,
  refreshCloudflareConnection,
  revokeCloudflareToken,
  startCloudflareDeviceLogin,
  validPresets,
  type CloudflareConnection,
  type CloudflareConnectorConfig,
  type CloudflareDeviceLogin,
} from "./cli-connector-cloudflare";
import {
  CLOUDFLARE_DEVICE_LOGIN_KIND,
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

function parseCloudflareConnection(
  payload: string,
): CloudflareConnection | undefined {
  const value = parseJson(payload);
  return value?.version === 2 && value.type === "cloudflare-oauth"
    ? value
    : undefined;
}

function pendingSelector(
  account_id: string,
  connector: CliConnector,
): ExternalCredentialSelector {
  return {
    provider: CLI_CONNECTOR_INFO[connector].provider,
    kind:
      connector === "github"
        ? GITHUB_DEVICE_LOGIN_KIND
        : CLOUDFLARE_DEVICE_LOGIN_KIND,
    scope: "account",
    owner_account_id: account_id,
  };
}

/** Which connectors this site has set up (no secrets). */
export async function getCliConnectorSetup({
  account_id,
}: {
  account_id?: string;
}): Promise<CliConnectorSetup> {
  requireUuid(account_id, "account_id");
  const github = await getGithubConnectorConfig();
  const cloudflare = await getCloudflareConnectorConfig();
  return {
    github: { available: !!github, app_url: github?.app_url || undefined },
    cloudflare: { available: !!cloudflare },
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

// A finished provider exchange whose connection was never stored (hub crash)
// is revoked at the provider once it is this old.
const EXCHANGED_RECOVERY_MS = 2 * 60_000;
// Keep an exchanged sign-in (and its tokens) until it is stored or revoked,
// instead of letting the pending lease silently drop them.
const EXCHANGED_LEASE_MS = 30 * 24 * 3_600_000;
// How long a reserved sign-in may wait for the provider's device code.
const STARTING_LEASE_MS = 15 * 60_000;

type ProviderConfig =
  | { connector: "github"; config: GithubConnectorConfig }
  | { connector: "cloudflare"; config: CloudflareConnectorConfig };
type ProviderConnection = GithubAppConnection | CloudflareConnection;

/**
 * A pending sign-in. The hub admits at most one provider poll per interval;
 * tokens the provider issued stay here, encrypted, until they are stored as a
 * connection or their revocation is confirmed.
 */
type PendingSignIn = (GithubDeviceLogin | CloudflareDeviceLogin) & {
  /** Reserved before the provider gave a device code. */
  starting?: boolean;
  /** Seconds between provider polls; grows on slow_down. */
  interval: number;
  next_poll_at: number;
  /** The poll admitted to ask the provider. */
  claim?: string;
  exchanged?: ProviderConnection;
  exchanged_at?: number;
  /** Not stored as a connection; only revocation remains to be confirmed. */
  cleanup_pending?: boolean;
};

async function providerConfig(
  connector: CliConnector,
): Promise<ProviderConfig | undefined> {
  if (connector === "github") {
    const config = await getGithubConnectorConfig();
    return config ? { connector, config } : undefined;
  }
  const config = await getCloudflareConnectorConfig();
  return config ? { connector, config } : undefined;
}

function deviceLoginType(connector: CliConnector): string {
  return connector === "github"
    ? "github-device-login"
    : "cloudflare-device-login";
}

function parsePending(
  payload: string,
  connector: CliConnector,
): PendingSignIn | undefined {
  const value = parseJson(payload);
  return value?.type === deviceLoginType(connector) &&
    Number.isFinite(value.next_poll_at)
    ? value
    : undefined;
}

/**
 * Make provider tokens CoCalc will not keep unusable. True once the provider
 * confirmed it (an already invalid token counts). Uses the client that issued
 * the tokens: a GitHub token can only be revoked with its own app's secret.
 */
async function revokeProviderConnection(
  connector: CliConnector,
  connection: ProviderConnection,
): Promise<boolean> {
  try {
    if (connector === "github") {
      const config = await getGithubConnectorConfig();
      if (!config || config.client_id !== connection.client_id) return false;
      await revokeGithubToken({ config, token: connection.access_token });
      return true;
    }
    for (const hint of ["refresh_token", "access_token"] as const) {
      await revokeCloudflareToken({
        config: { client_id: connection.client_id },
        token: (connection as CloudflareConnection)[hint],
        hint,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Who the tokens belong to; needs only the access token. */
async function describeConnection(
  connector: CliConnector,
  connection: ProviderConnection,
): Promise<string> {
  if (connector === "github") {
    return sanitizeConnectionDescription(
      `@${await githubLogin(connection.access_token)}`,
    );
  }
  const email = sanitizeConnectionDescription(
    await cloudflareEmail(connection.access_token),
  ).slice(0, 80);
  return `${email || "Cloudflare"} (${presetLabels(
    (connection as CloudflareConnection).presets,
  )})`;
}

/**
 * Revoke tokens of sign-ins that were never stored: those whose storing
 * failed earlier, and those left when the hub stopped between the provider
 * exchange and storing. A sign-in is removed only once its revocation is
 * confirmed; otherwise it is kept, encrypted, for the next attempt.
 */
async function recoverExchangedSignIns({
  owner,
  connector,
  now,
}: {
  owner: string;
  connector: CliConnector;
  now: number;
}): Promise<void> {
  const sel = pendingSelector(owner, connector);
  const rows = await listExternalCredentials({
    owner_account_id: owner,
    provider: sel.provider,
    kind: sel.kind,
    scope: "account",
  });
  for (const row of rows) {
    let cleaned = false;
    await updateExternalCredentialPayloadLocked({
      selector: sel,
      id: row.id,
      update: async (credential) => {
        const pending = parsePending(credential.payload, connector);
        if (
          !pending?.exchanged ||
          (!pending.cleanup_pending &&
            now - (pending.exchanged_at ?? 0) < EXCHANGED_RECOVERY_MS)
        ) {
          return;
        }
        if (await revokeProviderConnection(connector, pending.exchanged)) {
          cleaned = true;
          return {
            payload: JSON.stringify({ ...pending, exchanged: undefined }),
          };
        }
        return {
          payload: JSON.stringify({ ...pending, cleanup_pending: true }),
        };
      },
    });
    if (cleaned) {
      await revokeExternalCredential({ id: row.id, owner_account_id: owner });
    }
  }
}

/**
 * Start signing in to a connector's provider (fresh authentication): the user
 * approves the returned code at the provider, then the browser polls.
 * Cloudflare requests only the scopes of the chosen presets. A sign-in is
 * reserved (at most a few per account) before the provider is asked.
 */
export async function startCliConnectorSignIn({
  account_id,
  session_hash,
  connector: connectorInput,
  presets: presetsInput,
}: {
  account_id?: string;
  session_hash?: string;
  connector: string;
  presets?: string[];
}): Promise<CliConnectorSignIn> {
  // Server time only: never a value from the request.
  const now = Date.now();
  const owner = requireUuid(account_id, "account_id");
  const connector = requireConnector(connectorInput);
  const presets =
    connector === "cloudflare" ? validPresets(presetsInput) : undefined;
  await assertAccountHome(owner);
  const provider = await providerConfig(connector);
  if (!provider) {
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
  await recoverExchangedSignIns({ owner, connector, now });
  const sel = pendingSelector(owner, connector);
  const lease = (at: number) => ({
    connector,
    [EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY]: new Date(at).toISOString(),
  });
  // Admission before any provider request.
  const { id } = await createExternalCredential({
    selector: sel,
    payload: JSON.stringify({
      version: 1,
      type: deviceLoginType(connector),
      starting: true,
      client_id: "",
      device_code: "",
      expires_at: now + STARTING_LEASE_MS,
      interval: 5,
      next_poll_at: now + STARTING_LEASE_MS,
    }),
    metadata: lease(now + STARTING_LEASE_MS),
    maxActive: MAX_PENDING_SIGN_INS,
  });
  let started:
    | Awaited<ReturnType<typeof startGithubDeviceLogin>>
    | Awaited<ReturnType<typeof startCloudflareDeviceLogin>>;
  try {
    started =
      provider.connector === "github"
        ? await startGithubDeviceLogin({ config: provider.config, now })
        : await startCloudflareDeviceLogin({
            config: provider.config,
            presets: presets!,
            now,
          });
  } catch (err) {
    await revokeExternalCredential({ id, owner_account_id: owner });
    throw err;
  }
  const pending: PendingSignIn = {
    ...started.login,
    interval: started.interval,
    next_poll_at: now + started.interval * 1000,
  };
  await updateExternalCredentialPayloadLocked({
    selector: sel,
    id,
    update: async (credential) => ({
      payload: JSON.stringify(pending),
      metadata: { ...credential.metadata, ...lease(started.login.expires_at) },
    }),
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

/**
 * Finish a sign-in once the user approved it at the provider. The hub admits
 * at most one provider poll per interval, committed before the request, so
 * neither fast nor failing polls reach the provider more often. Tokens the
 * provider issues are recorded first, then stored as a connection or revoked;
 * they are dropped only once one of those is confirmed.
 */
export async function pollCliConnectorSignIn({
  account_id,
  connector: connectorInput,
  login_id,
}: {
  account_id?: string;
  connector: string;
  login_id: string;
}): Promise<CliConnectorSignInStatus> {
  // Server time only: never a value from the request.
  const now = Date.now();
  const owner = requireUuid(account_id, "account_id");
  const connector = requireConnector(connectorInput);
  const id = requireUuid(login_id, "login_id");
  await assertAccountHome(owner);
  const sel = pendingSelector(owner, connector);
  const consume = () =>
    revokeExternalCredential({ id, owner_account_id: owner });

  // Phase 0: admission, committed before any provider request.
  type Admission = "missing" | "early" | "admitted" | "exchanged";
  let admission = "missing" as Admission;
  const claim = randomUUID();
  await updateExternalCredentialPayloadLocked({
    selector: sel,
    id,
    update: async (credential) => {
      const pending = parsePending(credential.payload, connector);
      if (!pending) return;
      if (pending.exchanged) {
        admission = "exchanged";
        return;
      }
      if (now < pending.next_poll_at) {
        admission = "early";
        return;
      }
      admission = "admitted";
      return {
        payload: JSON.stringify({
          ...pending,
          claim,
          next_poll_at: now + pending.interval * 1000,
        }),
      };
    },
  });
  if (admission === "missing") return { status: "expired" };
  if (admission === "early") return { status: "pending" };

  // Phase 1: the admitted provider request; issued tokens are recorded.
  if (admission === "admitted") {
    const provider = await providerConfig(connector);
    type Exchange =
      | { status: "pending"; slow_down?: boolean }
      | { status: "expired" | "denied" }
      | { status: "exchanged" };
    let exchange = { status: "pending" } as Exchange;
    let issued: ProviderConnection | undefined;
    try {
      await updateExternalCredentialPayloadLocked({
        selector: sel,
        id,
        update: async (credential) => {
          const pending = parsePending(credential.payload, connector);
          // Another poll took over, or the sign-in finished meanwhile.
          if (!pending || pending.claim !== claim || pending.exchanged) {
            return;
          }
          if (!provider) {
            exchange = { status: "expired" };
            return;
          }
          const result =
            provider.connector === "github"
              ? await pollGithubDeviceLogin({
                  config: provider.config,
                  login: pending as GithubDeviceLogin,
                  now,
                })
              : await pollCloudflareDeviceLogin({
                  config: provider.config,
                  login: pending as CloudflareDeviceLogin,
                  now,
                });
          if (result.status === "pending") {
            exchange = result;
            if (!result.slow_down) return;
            const interval = pending.interval + 5;
            return {
              payload: JSON.stringify({
                ...pending,
                interval,
                next_poll_at: now + interval * 1000,
              }),
            };
          }
          if (result.status !== "connected") {
            exchange = result;
            return;
          }
          issued = result.connection;
          exchange = { status: "exchanged" };
          return {
            payload: JSON.stringify({
              ...pending,
              exchanged: result.connection,
              exchanged_at: now,
            }),
            metadata: {
              ...credential.metadata,
              [EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY]: new Date(
                now + EXCHANGED_LEASE_MS,
              ).toISOString(),
            },
          };
        },
      });
    } catch (err) {
      // Issued tokens that could not be recorded must not stay valid.
      if (issued) await revokeProviderConnection(connector, issued);
      throw err;
    }
    if (exchange.status === "pending") return exchange;
    if (exchange.status !== "exchanged") {
      await consume();
      return exchange;
    }
  }

  // Phase 2: store the connection (once, even across retries), or else
  // revoke the tokens; drop them only when one of those succeeded.
  let connection: CliConnection | undefined;
  let failure: unknown;
  let done = false;
  await updateExternalCredentialPayloadLocked({
    selector: sel,
    id,
    update: async (credential) => {
      const pending = parsePending(credential.payload, connector);
      if (!pending?.exchanged) return;
      if (!pending.cleanup_pending) {
        try {
          const description = await describeConnection(
            connector,
            pending.exchanged,
          );
          const { id: connection_id } = await createExternalCredential({
            selector: selector(owner, connector),
            payload: JSON.stringify(pending.exchanged),
            metadata: {
              description,
              connector,
              source: "device-flow",
              sign_in_id: id,
            },
            deduplicateMetadata: { key: "sign_in_id", value: id },
            maxActive: MAX_CONNECTIONS_PER_CONNECTOR,
          });
          connection = {
            connection_id,
            connector,
            description,
            created: new Date(),
            last_used: null,
          };
          done = true;
          return {
            payload: JSON.stringify({ ...pending, exchanged: undefined }),
          };
        } catch (err) {
          failure = err;
        }
      } else {
        failure = Error("this sign-in could not be completed");
      }
      if (await revokeProviderConnection(connector, pending.exchanged)) {
        done = true;
        return {
          payload: JSON.stringify({ ...pending, exchanged: undefined }),
        };
      }
      // Keep the tokens, encrypted, until revocation can be confirmed.
      return {
        payload: JSON.stringify({ ...pending, cleanup_pending: true }),
      };
    },
  });
  if (done) await consume();
  if (failure) throw failure;
  return connection
    ? { status: "connected", connection }
    : { status: "expired" };
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
  // Also invalidate the tokens at the provider, best effort: CoCalc's copy
  // is gone either way.
  const github = parseGithubConnection(connection.payload);
  const githubConfig = github ? await getGithubConnectorConfig() : undefined;
  if (github && githubConfig?.client_id === github.client_id) {
    await revokeGithubToken({
      config: githubConfig,
      token: github.access_token,
    }).catch(() => undefined);
  }
  const cloudflare = parseCloudflareConnection(connection.payload);
  const cloudflareConfig = cloudflare
    ? await getCloudflareConnectorConfig()
    : undefined;
  if (cloudflare && cloudflareConfig?.client_id === cloudflare.client_id) {
    await revokeCloudflareToken({
      config: cloudflareConfig,
      token: cloudflare.refresh_token,
    }).catch(() => undefined);
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
}): Promise<CliConnectorTurnToken[]> {
  // Server time only: never a value from the request.
  const now = Date.now();
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
      if (!isCliConnector(grant.connector)) continue;
      const token = await connectorTurnToken({
        connector: grant.connector,
        owner,
        connection_id: grant.connection_id!,
        now,
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

type Refreshable = {
  access_token: string;
  access_expires_at: number;
};

/**
 * An access token for one turn, refreshed under the connection's lock when
 * it is close to expiry. A connection the provider refuses to refresh is
 * marked for signing in again and gives no token.
 */
async function connectorTurnToken({
  connector,
  owner,
  connection_id,
  now,
}: {
  connector: CliConnector;
  owner: string;
  connection_id: string;
  now: number;
}): Promise<CliConnectorTurnToken | undefined> {
  let refresh:
    | ((
        payload: string,
      ) => Promise<{ connection: Refreshable; refreshed: boolean } | undefined>)
    | undefined;
  if (connector === "github") {
    const config = await getGithubConnectorConfig();
    if (!config) return;
    refresh = async (payload) => {
      const connection = parseGithubConnection(payload);
      return connection
        ? await refreshGithubConnection({ config, connection, now })
        : undefined;
    };
  } else {
    const config = await getCloudflareConnectorConfig();
    if (!config) return;
    refresh = async (payload) => {
      const connection = parseCloudflareConnection(payload);
      return connection
        ? await refreshCloudflareConnection({
            config,
            connection,
            now,
          })
        : undefined;
    };
  }
  let current: Refreshable | undefined;
  const updated = await updateExternalCredentialPayloadLocked({
    selector: selector(owner, connector),
    id: connection_id,
    update: async (credential) => {
      if (credential.metadata?.needs_reconnect) return;
      try {
        const result = await refresh!(credential.payload);
        if (!result) return;
        current = result.connection;
        return result.refreshed
          ? { payload: JSON.stringify(result.connection) }
          : undefined;
      } catch (err) {
        if (
          !(err instanceof GithubReconnectRequired) &&
          !(err instanceof CloudflareReconnectRequired)
        ) {
          throw err;
        }
        return {
          payload: credential.payload,
          metadata: { ...credential.metadata, needs_reconnect: true },
        };
      }
    },
  });
  if (!updated || !current) return;
  return {
    connector,
    token: current.access_token,
    expires_at: current.access_expires_at,
    description: `${updated.metadata?.description ?? ""}`,
  };
}
