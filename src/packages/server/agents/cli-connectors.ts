/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// CLI connectors (gh, cf): account connections, per-agent grants, and the
// short-lived tokens handed to each verified agent turn. Runs at the account's
// home bay. Plan: src/.agents/cli-connectors-github-cloudflare-plan-2026-10-05.md

import { randomUUID, timingSafeEqual } from "node:crypto";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:agents:cli-connectors");
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
  ProviderRejectedTokens,
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
  exchangeCloudflareCode,
  getCloudflareConnectorConfig,
  parseCloudflareState,
  presetLabels,
  refreshCloudflareConnection,
  revokeCloudflareToken,
  startCloudflareAuthorization,
  validPresets,
  type CloudflareAuthLogin,
  type CloudflareConnection,
  type CloudflareConnectorConfig,
} from "./cli-connector-cloudflare";
import {
  CLOUDFLARE_OAUTH_LOGIN_KIND,
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
        : CLOUDFLARE_OAUTH_LOGIN_KIND,
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
      if (row.metadata?.disconnecting) continue;
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
// instead of letting the pending lease silently drop them: longer than any
// refresh token lives (GitHub: about 184 days), renewed after every failed
// cleanup.
const EXCHANGED_LEASE_MS = 200 * 24 * 3_600_000;
// Sign-in requests one hub process sends to one provider client, per window:
// many accounts together cannot exhaust a site's shared client.
const PROVIDER_REQUESTS_PER_WINDOW = 30;
const PROVIDER_WINDOW_MS = 10_000;
const providerRequests = new Map<string, number[]>();

/** Take one provider request from the budget; false when it is used up. */
function admitProviderRequest(client_id: string, now: number): boolean {
  const recent = (providerRequests.get(client_id) ?? []).filter(
    (at) => now - at < PROVIDER_WINDOW_MS,
  );
  if (recent.length >= PROVIDER_REQUESTS_PER_WINDOW) {
    providerRequests.set(client_id, recent);
    return false;
  }
  recent.push(now);
  providerRequests.set(client_id, recent);
  return true;
}

/** For tests. */
export function resetProviderRequestBudget(): void {
  providerRequests.clear();
}

function cleanupLease(now: number) {
  return {
    [EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY]: new Date(
      now + EXCHANGED_LEASE_MS,
    ).toISOString(),
  };
}

/**
 * Tokens whose revocation could not be confirmed, kept (encrypted) for a
 * later attempt. This kind is never lease-swept: a record goes away only once
 * its revocation is confirmed.
 */
function cleanupSelector(
  account_id: string,
  connector: CliConnector,
): ExternalCredentialSelector {
  return {
    provider: CLI_CONNECTOR_INFO[connector].provider,
    kind: `${connector}-token-cleanup`,
    scope: "account",
    owner_account_id: account_id,
  };
}

async function rescueUnrevokedTokens({
  owner,
  connector,
  tokens,
  now,
}: {
  owner: string;
  connector: CliConnector;
  tokens: ProviderTokens;
  now: number;
}): Promise<void> {
  try {
    await createExternalCredential({
      selector: cleanupSelector(owner, connector),
      payload: JSON.stringify({
        version: 1,
        type: "token-cleanup",
        tokens: {
          client_id: tokens.client_id,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        },
        at: now,
      }),
      metadata: { connector },
    });
  } catch (err) {
    logger.error("CLI connector tokens could not be revoked or kept", {
      account_id: owner,
      connector,
      err: `${err}`,
    });
  }
}

/** Revoke tokens, or keep them for a later attempt when that fails. */
async function disposeTokens({
  owner,
  connector,
  tokens,
  now,
}: {
  owner: string;
  connector: CliConnector;
  tokens: ProviderTokens;
  now: number;
}): Promise<void> {
  if (!(await revokeProviderConnection(connector, tokens))) {
    await rescueUnrevokedTokens({ owner, connector, tokens, now });
  }
}

/**
 * Retry revocations left by earlier failures: cleanup records, and
 * connections a disconnect could not revoke yet.
 */
async function retryPendingRevocations({
  owner,
  connector,
}: {
  owner: string;
  connector: CliConnector;
}): Promise<void> {
  const cleanup = cleanupSelector(owner, connector);
  for (const row of await listExternalCredentials({
    owner_account_id: owner,
    provider: cleanup.provider,
    kind: cleanup.kind,
    scope: "account",
  })) {
    const record = await getExternalCredentialById({
      id: row.id,
      selector: cleanup,
      touchLastUsed: false,
    });
    const tokens = record ? parseJson(record.payload)?.tokens : undefined;
    if (!tokens) continue;
    if (await revokeProviderConnection(connector, tokens)) {
      await revokeExternalCredential({ id: row.id, owner_account_id: owner });
    }
  }
  const connections = selector(owner, connector);
  for (const row of await listExternalCredentials({
    owner_account_id: owner,
    provider: connections.provider,
    kind: connections.kind,
    scope: "account",
  })) {
    if (!row.metadata?.disconnecting) continue;
    const record = await getExternalCredentialById({
      id: row.id,
      selector: connections,
      touchLastUsed: false,
    });
    const tokens = record ? parseJson(record.payload) : undefined;
    if (tokens && (await revokeProviderConnection(connector, tokens))) {
      await revokeExternalCredential({ id: row.id, owner_account_id: owner });
    }
  }
}

// A completion claim left by a stopped hub expires after this.
const CLAIM_MS = 60_000;
// How long a reserved sign-in may wait for the provider's device code.
const STARTING_LEASE_MS = 15 * 60_000;

type ProviderConfig =
  | { connector: "github"; config: GithubConnectorConfig }
  | { connector: "cloudflare"; config: CloudflareConnectorConfig };
type ProviderConnection = GithubAppConnection | CloudflareConnection;
/** What revoking needs: the issuing client and whichever tokens exist. */
type ProviderTokens = {
  client_id: string;
  access_token?: string;
  refresh_token?: string;
};

/**
 * A pending sign-in. The hub admits at most one provider poll per interval;
 * tokens the provider issued stay here, encrypted, until they are stored as a
 * connection or their revocation is confirmed.
 */
type PendingSignIn = (GithubDeviceLogin | CloudflareAuthLogin) & {
  /** Reserved before the provider was asked. */
  starting?: boolean;
  /** GitHub: seconds between provider polls; grows on slow_down. */
  interval: number;
  next_poll_at: number;
  /** The poll or completion admitted to ask the provider. */
  claim?: string;
  claim_at?: number;
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
    : "cloudflare-oauth-login";
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
  connection: ProviderTokens,
): Promise<boolean> {
  try {
    if (connector === "github") {
      const config = await getGithubConnectorConfig();
      if (!config || config.client_id !== connection.client_id) return false;
      // GitHub revokes a user token by its access token.
      if (connection.access_token) {
        await revokeGithubToken({ config, token: connection.access_token });
      } else if (connection.refresh_token) {
        return false;
      }
      return true;
    }
    const config = await getCloudflareConnectorConfig();
    if (!config || config.client_id !== connection.client_id) return false;
    for (const hint of ["refresh_token", "access_token"] as const) {
      const token = connection[hint];
      if (token) await revokeCloudflareToken({ config, token, hint });
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
          metadata: { ...credential.metadata, ...cleanupLease(now) },
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
  await retryPendingRevocations({ owner, connector });
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
  if (provider.connector === "cloudflare") {
    // The user approves at Cloudflare and is sent back to the site.
    const authorization = startCloudflareAuthorization({
      config: provider.config,
      presets: presets!,
      login_id: id,
      now,
    });
    await updateExternalCredentialPayloadLocked({
      selector: sel,
      id,
      update: async (credential) => ({
        payload: JSON.stringify({
          ...authorization.login,
          interval: 0,
          next_poll_at: 0,
        }),
        metadata: {
          ...credential.metadata,
          ...lease(authorization.login.expires_at),
        },
      }),
    });
    return {
      login_id: id,
      connector,
      kind: "redirect",
      authorize_url: authorization.authorize_url,
      expires_at: authorization.login.expires_at,
    };
  }
  let started: Awaited<ReturnType<typeof startGithubDeviceLogin>>;
  try {
    if (!admitProviderRequest(provider.config.client_id, now)) {
      throw Error(
        "Too many sign-ins on this site right now; try again shortly",
      );
    }
    started = await startGithubDeviceLogin({ config: provider.config, now });
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
    kind: "device",
    user_code: started.user_code,
    verification_uri: started.verification_uri,
    interval: started.interval,
    expires_at: started.login.expires_at,
  };
}

type ProviderAnswer =
  | { status: "pending"; slow_down?: boolean }
  | { status: "expired" | "denied" }
  | { status: "connected"; connection: ProviderConnection };

/**
 * The provider exchange of a sign-in and what follows, shared by GitHub polls
 * and Cloudflare's redirect completion:
 * 0. admission under the sign-in's lock, committed before any provider
 *    request, so neither repeated nor failing calls reach the provider more
 *    often than admitted;
 * 1. the admitted provider request; issued tokens are recorded first;
 * 2. the tokens are stored as a connection or else revoked, and dropped only
 *    once one of those is confirmed.
 */
async function runSignIn({
  owner,
  connector,
  id,
  now,
  admit,
  ask,
}: {
  owner: string;
  connector: CliConnector;
  id: string;
  now: number;
  /** Phase 0: undefined admits (with the returned changes), else a status. */
  admit: (
    pending: PendingSignIn,
  ) =>
    | { admitted: true; changes?: Partial<PendingSignIn> }
    | { admitted: false; status: CliConnectorSignInStatus };
  ask: (
    provider: ProviderConfig,
    pending: PendingSignIn,
  ) => Promise<ProviderAnswer>;
}): Promise<CliConnectorSignInStatus> {
  const sel = pendingSelector(owner, connector);
  const consume = () =>
    revokeExternalCredential({ id, owner_account_id: owner });

  // Phase 0.
  // Assigned in the locked update below.
  let admission = { kind: "missing" } as
    | { kind: "missing" | "admitted" | "exchanged" }
    | { kind: "refused"; status: CliConnectorSignInStatus };
  const claim = randomUUID();
  await updateExternalCredentialPayloadLocked({
    selector: sel,
    id,
    update: async (credential) => {
      const pending = parsePending(credential.payload, connector);
      if (!pending) return;
      if (pending.exchanged) {
        admission = { kind: "exchanged" };
        return;
      }
      const decision = admit(pending);
      if (!decision.admitted) {
        admission = { kind: "refused", status: decision.status };
        return;
      }
      admission = { kind: "admitted" };
      return {
        payload: JSON.stringify({
          ...pending,
          ...decision.changes,
          claim,
          claim_at: now,
        }),
      };
    },
  });
  if (admission.kind === "missing") return { status: "expired" };
  if (admission.kind === "refused") return admission.status;

  // Phase 1.
  if (admission.kind === "admitted") {
    const provider = await providerConfig(connector);
    let exchange = { status: "pending" } as
      | { status: "pending"; slow_down?: boolean }
      | { status: "expired" | "denied" }
      | { status: "exchanged" };
    let issued: ProviderConnection | undefined;
    try {
      await updateExternalCredentialPayloadLocked({
        selector: sel,
        id,
        update: async (credential) => {
          const pending = parsePending(credential.payload, connector);
          // Another call took over, or the sign-in finished meanwhile.
          if (!pending || pending.claim !== claim || pending.exchanged) {
            return;
          }
          if (!provider) {
            exchange = { status: "expired" };
            return;
          }
          if (!admitProviderRequest(provider.config.client_id, now)) {
            // The site's shared budget is used up: release the claim so the
            // same call can be retried shortly.
            exchange = { status: "pending", slow_down: true };
            return {
              payload: JSON.stringify({
                ...pending,
                claim: undefined,
                claim_at: undefined,
              }),
            };
          }
          const result = await ask(provider, pending);
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
            metadata: { ...credential.metadata, ...cleanupLease(now) },
          };
        },
      });
    } catch (err) {
      // Issued tokens that could not be recorded, or that were rejected,
      // must not stay valid; if that cannot be confirmed, keep them.
      const tokens =
        issued ??
        (err instanceof ProviderRejectedTokens ? err.tokens : undefined);
      if (tokens) await disposeTokens({ owner, connector, tokens, now });
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
        metadata: { ...credential.metadata, ...cleanupLease(now) },
      };
    },
  });
  if (done) await consume();
  if (failure) throw failure;
  return connection
    ? { status: "connected", connection }
    : { status: "expired" };
}

/**
 * GitHub: finish a sign-in once the user approved the code. At most one
 * request reaches GitHub per polling interval, however often this is called.
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
  return await runSignIn({
    owner,
    connector,
    id,
    now,
    admit: (pending) =>
      // Cloudflare sign-ins finish only through their redirect.
      pending.type !== "github-device-login" || now < pending.next_poll_at
        ? { admitted: false, status: { status: "pending" } }
        : {
            admitted: true,
            changes: { next_poll_at: now + pending.interval * 1000 },
          },
    ask: async (provider, pending) =>
      await pollGithubDeviceLogin({
        config: (provider as { config: GithubConnectorConfig }).config,
        login: pending as GithubDeviceLogin,
        now,
      }),
  });
}

/**
 * Cloudflare: finish a sign-in when the user comes back from Cloudflare with
 * a code. The state must name this account's sign-in and carry its secret
 * nonce; each sign-in exchanges a code at most once.
 */
export async function completeCliConnectorSignIn({
  account_id,
  connector: connectorInput,
  state,
  code,
}: {
  account_id?: string;
  connector: string;
  state: string;
  code: string;
}): Promise<CliConnectorSignInStatus> {
  // Server time only: never a value from the request.
  const now = Date.now();
  const owner = requireUuid(account_id, "account_id");
  const connector = requireConnector(connectorInput);
  if (connector !== "cloudflare") throw Error("not a redirect sign-in");
  const parsed = parseCloudflareState(state);
  if (!parsed || typeof code !== "string" || !code || code.length > 2048) {
    throw Error("invalid sign-in response");
  }
  const id = requireUuid(parsed.login_id, "login_id");
  await assertAccountHome(owner);
  return await runSignIn({
    owner,
    connector,
    id,
    now,
    admit: (pending) => {
      const expected = Buffer.from(
        pending.type === "cloudflare-oauth-login" ? pending.nonce : "",
      );
      const given = Buffer.from(parsed.nonce);
      if (
        pending.type !== "cloudflare-oauth-login" ||
        expected.length !== given.length ||
        !timingSafeEqual(expected, given)
      ) {
        return { admitted: false, status: { status: "expired" } };
      }
      // A second completion while one is under way asks nothing; a claim
      // left by a stopped hub expires.
      if (pending.claim && now - (pending.claim_at ?? 0) < CLAIM_MS) {
        return { admitted: false, status: { status: "pending" } };
      }
      return { admitted: true };
    },
    ask: async (provider, pending) =>
      await exchangeCloudflareCode({
        config: (provider as { config: CloudflareConnectorConfig }).config,
        login: pending as CloudflareAuthLogin,
        code,
        now,
      }),
  });
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
  const index = found.findIndex(Boolean);
  if (index < 0) throw Error("connection is unavailable");
  const connector = (Object.keys(CLI_CONNECTOR_INFO) as CliConnector[])[index];
  // The record becomes cleanup-only (never used again, not listed) and stays
  // until the provider confirms the tokens are revoked; a later sign-in start
  // retries otherwise.
  const marked = await updateExternalCredentialPayloadLocked({
    selector: selector(owner, connector),
    id,
    update: async (credential) => ({
      payload: credential.payload,
      metadata: { ...credential.metadata, disconnecting: true },
    }),
  });
  // Marked first: from now on no turn refreshes (rotates) these tokens and a
  // grant enabled meanwhile turns itself off, so the grants go off for good.
  // Stopping access never needs fresh authentication.
  await getPool().query(
    `UPDATE agent_connector_grants
        SET enabled=false, connection_id=NULL, revision=revision+1, updated_at=now()
      WHERE account_id=$1 AND connection_id=$2`,
    [owner, id],
  );
  // Revoke the tokens as they were when marked (the last version).
  const tokens = marked ? parseJson(marked.payload) : undefined;
  if (tokens && (await revokeProviderConnection(connector, tokens))) {
    await revokeExternalCredential({ id, owner_account_id: owner });
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
  // Not one being disconnected (e.g. from another, stale tab).
  if (!connection || connection.metadata?.disconnecting) {
    throw Error("connection is unavailable");
  }
  // The account-scoped lock makes the count and the insert one step, so
  // concurrent first writes cannot exceed the bound.
  let saved: CliConnectorGrant;
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
    saved = rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  // A disconnect that started meanwhile marks the connection before turning
  // its grants off; checking again after saving means one of the two always
  // leaves this grant off.
  const after = await getExternalCredentialById({
    id: connection_id!,
    selector: selector(owner, connector),
    touchLastUsed: false,
  });
  if (!after || after.metadata?.disconnecting) {
    await getPool().query(
      `UPDATE agent_connector_grants
          SET enabled=false, connection_id=NULL, revision=revision+1, updated_at=now()
        WHERE grant_id=$1 AND connection_id=$2`,
      [saved.grant_id, connection_id],
    );
    throw Error("connection is unavailable");
  }
  return saved;
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
      if (
        credential.metadata?.needs_reconnect ||
        credential.metadata?.disconnecting
      ) {
        return;
      }
      try {
        const result = await refresh!(credential.payload);
        if (!result) return;
        current = result.connection;
        return result.refreshed
          ? { payload: JSON.stringify(result.connection) }
          : undefined;
      } catch (err) {
        if (err instanceof ProviderRejectedTokens) {
          // Rotated tokens CoCalc will not use: revoke them or keep them.
          await disposeTokens({ owner, connector, tokens: err.tokens, now });
        } else if (
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
