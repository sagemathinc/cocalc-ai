import { resolveAgentTokenFromEnv } from "../../core/agent-token";
import { resolve } from "node:path";
import { ENV_AUTH_PROFILE } from "../../core/auth-config";
import { buildCookieHeader } from "../../core/auth-cookies";
import {
  managedConnectorCredentialFromEnv,
  prepareManagedConnectorDaemonGlobals,
  type ManagedConnectorCredential,
} from "./managed-connector-auth";
import { resolveApiKeyFileGlobals } from "./api-key-file";

export type DaemonGlobalAuthOptions = {
  profile?: string;
  api?: string;
  accountId?: string;
  account_id?: string;
  apiKey?: string;
  apiKeyFile?: string;
  cookie?: string;
  bearer?: string;
  hubPassword?: string;
  noDaemon?: boolean;
  disableEnvAuthDefaults?: boolean;
  managedConnector?: ManagedConnectorCredential;
  authProjectId?: string;
};

export function prepareDaemonAuthGlobals<T extends DaemonGlobalAuthOptions>(
  globals: T,
): T & DaemonGlobalAuthOptions {
  return {
    ...prepareManagedConnectorDaemonGlobals(resolveApiKeyFileGlobals(globals)),
    profile: ENV_AUTH_PROFILE,
    disableEnvAuthDefaults: true,
  };
}

export function shouldUseFileOpsDaemon(
  globals: DaemonGlobalAuthOptions & { daemon?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.COCALC_CLI_DAEMON_MODE === "1") return false;
  if (globals.daemon === false) return false;
  return globals.noDaemon !== true;
}

export function effectiveDaemonGlobals<T extends DaemonGlobalAuthOptions>(
  globals: T,
  {
    env = process.env,
    defaultApiBaseUrl,
  }: {
    env?: NodeJS.ProcessEnv;
    defaultApiBaseUrl?: () => string;
  } = {},
): T & DaemonGlobalAuthOptions {
  const next = { ...globals } as T & DaemonGlobalAuthOptions;

  if (!next.api) {
    const api = `${env.COCALC_API_URL ?? env.BASE_URL ?? ""}`.trim();
    if (api) {
      next.api = api;
    } else if (defaultApiBaseUrl) {
      next.api = defaultApiBaseUrl();
    }
  }

  if (next.apiKeyFile) {
    next.apiKeyFile = resolve(next.apiKeyFile);
    next.disableEnvAuthDefaults = true;
    return next;
  }

  if (next.disableEnvAuthDefaults) {
    return next;
  }

  const managedConnector = managedConnectorCredentialFromEnv(env);
  if (managedConnector) {
    next.managedConnector = {
      ...managedConnector,
      keyFile: resolve(managedConnector.keyFile),
    };
    next.profile = ENV_AUTH_PROFILE;
    next.disableEnvAuthDefaults = true;
  }

  if (!next.accountId && !next.account_id) {
    const accountId = `${env.COCALC_ACCOUNT_ID ?? ""}`.trim();
    if (accountId) {
      next.accountId = accountId;
    }
  }

  if (!next.apiKey && !managedConnector) {
    const apiKey = `${env.COCALC_API_KEY ?? ""}`.trim();
    if (apiKey) {
      next.apiKey = apiKey;
    }
  }

  if (!next.bearer) {
    next.bearer = resolveAgentTokenFromEnv(env);
  }
  next.authProjectId = `${env.COCALC_PROJECT_ID ?? ""}`.trim() || undefined;

  if (!next.hubPassword && !managedConnector) {
    const hubPassword = `${env.COCALC_HUB_PASSWORD ?? ""}`.trim();
    if (hubPassword) {
      next.hubPassword = hubPassword;
    }
  }

  if (
    !next.apiKey &&
    !next.bearer &&
    !next.hubPassword &&
    !next.cookie &&
    next.api
  ) {
    next.cookie = buildCookieHeader(next.api, next, {}, env) || undefined;
  }
  next.disableEnvAuthDefaults = true;
  return next;
}
