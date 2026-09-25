import { resolveAgentTokenFromEnv } from "../../core/agent-token";

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
};

export function shouldUseFileOpsDaemon(
  globals: DaemonGlobalAuthOptions & { daemon?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.COCALC_CONNECTOR_API_KEY_FILE || globals.apiKeyFile) return false;
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

  if (next.disableEnvAuthDefaults) {
    return next;
  }

  if (!next.accountId && !next.account_id) {
    const accountId = `${env.COCALC_ACCOUNT_ID ?? ""}`.trim();
    if (accountId) {
      next.accountId = accountId;
    }
  }

  if (!next.apiKey) {
    const apiKey = `${env.COCALC_API_KEY ?? ""}`.trim();
    if (apiKey) {
      next.apiKey = apiKey;
    }
  }

  if (!next.bearer) {
    next.bearer = resolveAgentTokenFromEnv(env);
  }

  if (!next.hubPassword) {
    const hubPassword = `${env.COCALC_HUB_PASSWORD ?? ""}`.trim();
    if (hubPassword) {
      next.hubPassword = hubPassword;
    }
  }

  return next;
}
