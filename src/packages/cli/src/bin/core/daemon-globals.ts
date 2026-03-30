export type DaemonGlobalAuthOptions = {
  api?: string;
  accountId?: string;
  account_id?: string;
  apiKey?: string;
  cookie?: string;
  bearer?: string;
  hubPassword?: string;
  noDaemon?: boolean;
};

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
    const rawBearer = env.COCALC_BEARER_TOKEN;
    if (rawBearer !== undefined) {
      const bearer = `${rawBearer}`.trim();
      if (bearer) {
        next.bearer = bearer;
      }
    } else {
      const bearer = `${env.COCALC_AGENT_TOKEN ?? ""}`.trim();
      if (bearer) {
        next.bearer = bearer;
      }
    }
  }

  if (!next.hubPassword) {
    const hubPassword = `${env.COCALC_HUB_PASSWORD ?? ""}`.trim();
    if (hubPassword) {
      next.hubPassword = hubPassword;
    }
  }

  return next;
}
