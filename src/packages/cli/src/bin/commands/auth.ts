import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { describeProjectScopedAuth } from "../../core/auth-cookies";

export type AuthCommandDeps = {
  env: NodeJS.ProcessEnv;
  runLocalCommand: any;
  authConfigPath: any;
  loadAuthConfig: any;
  selectedProfileName: any;
  applyAuthProfile: any;
  normalizeUrl: any;
  defaultApiBaseUrl: any;
  getExplicitAccountId: any;
  durationToMs: any;
  connectRemote: any;
  resolveAccountIdFromRemote: any;
  buildCookieHeader: any;
  cookieNameFor: any;
  normalizeSecretValue: any;
  maskSecret: any;
  sanitizeProfileName: any;
  profileFromGlobals: any;
  saveAuthConfig: any;
  maybeCreateLocalDevRememberMeCookie: any;
};

export function registerAuthCommand(
  program: Command,
  deps: AuthCommandDeps,
): Command {
  const {
    env,
    runLocalCommand,
    authConfigPath,
    loadAuthConfig,
    selectedProfileName,
    applyAuthProfile,
    normalizeUrl,
    defaultApiBaseUrl,
    getExplicitAccountId,
    durationToMs,
    connectRemote,
    resolveAccountIdFromRemote,
    buildCookieHeader,
    cookieNameFor,
    normalizeSecretValue,
    maskSecret,
    sanitizeProfileName,
    profileFromGlobals,
    saveAuthConfig,
    maybeCreateLocalDevRememberMeCookie,
  } = deps;

  const auth = program.command("auth").description("auth profile management");

  type CliChallengeStart = {
    challenge_id: string;
    poll_token: string;
    approval_url: string;
    expires_at: string | Date;
    home_bay_id?: string;
    home_bay_url?: string;
  };

  type CliChallengeStatus = {
    challenge_id: string;
    kind: "login" | "elevate";
    state: "pending" | "approved" | "redeemed";
    expires_at: string | Date;
    redeem_token?: string;
    fresh_auth_until?: string | Date | null;
    factor_level?: string | null;
  };

  function apiUrl(apiBaseUrl: string, endpoint: string): string {
    const base = `${normalizeUrl(apiBaseUrl)}`.replace(/\/+$/, "");
    return `${base}/api/v2/${endpoint.replace(/^\/+/, "")}`;
  }

  async function postCliAuthApi<T = any>({
    apiBaseUrl,
    endpoint,
    body,
    cookieHeader,
  }: {
    apiBaseUrl: string;
    endpoint: string;
    body: object;
    cookieHeader?: string;
  }): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookieHeader?.trim()) {
      headers.Cookie = cookieHeader.trim();
    }
    const response = await fetch(apiUrl(apiBaseUrl, endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (json?.error) {
      const err: any = new Error(`${json.error}`);
      if (json?.code != null) {
        err.code = json.code;
      }
      throw err;
    }
    return json;
  }

  async function promptForEmail(): Promise<string> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("email is required when stdin is not interactive");
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return (await rl.question("Email address: ")).trim();
    } finally {
      rl.close();
    }
  }

  async function waitForCliChallenge({
    apiBaseUrl,
    endpoint,
    challenge_id,
    poll_token,
    pollMs,
  }: {
    apiBaseUrl: string;
    endpoint: string;
    challenge_id: string;
    poll_token: string;
    pollMs: number;
  }): Promise<CliChallengeStatus> {
    while (true) {
      const status = await postCliAuthApi<CliChallengeStatus>({
        apiBaseUrl,
        endpoint,
        body: { challenge_id, poll_token },
      });
      if (status.state !== "pending") {
        return status;
      }
      const expiresAt = new Date(status.expires_at).valueOf();
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        throw new Error("CLI auth challenge expired before approval");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  function buildRememberMeCookieHeader(
    apiBaseUrl: string,
    rememberMeCookie: string,
  ): string {
    const value = `${rememberMeCookie ?? ""}`.trim();
    const names = Array.from(
      new Set([cookieNameFor(apiBaseUrl, "remember_me"), "remember_me"]),
    ).filter(Boolean);
    return names.map((name) => `${name}=${value}`).join("; ");
  }

  function cookieHeaderHasRememberMe(
    cookieHeader: string | undefined,
  ): boolean {
    return `${cookieHeader ?? ""}`
      .split(";")
      .some((part) => part.trim().startsWith("remember_me="));
  }

  async function resolveBrowserLoginEmail(
    explicitEmail: string | undefined,
  ): Promise<string> {
    const email = `${explicitEmail ?? ""}`.trim();
    return email || (await promptForEmail());
  }

  function hasLegacyStoredCredentials(globals: any): boolean {
    const accountId = getExplicitAccountId(globals);
    return !!(
      accountId?.trim() ||
      normalizeSecretValue(globals.apiKey) ||
      normalizeSecretValue(globals.cookie) ||
      normalizeSecretValue(globals.bearer) ||
      normalizeSecretValue(globals.hubPassword)
    );
  }

  async function maybeRefreshProfileIdentity(profile: any): Promise<{
    email_address?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  }> {
    if (
      `${profile?.email_address ?? ""}`.trim() ||
      `${profile?.first_name ?? ""}`.trim() ||
      `${profile?.last_name ?? ""}`.trim()
    ) {
      return {
        email_address: profile?.email_address ?? null,
        first_name: profile?.first_name ?? null,
        last_name: profile?.last_name ?? null,
      };
    }
    const apiBaseUrl = `${profile?.api ?? ""}`.trim();
    const cookieHeader = `${profile?.cookie ?? ""}`.trim();
    if (!apiBaseUrl || !cookieHeader) {
      return {};
    }
    try {
      const response = await postCliAuthApi<{
        profile?: {
          account_id?: string | null;
          email_address?: string | null;
          first_name?: string | null;
          last_name?: string | null;
        } | null;
      }>({
        apiBaseUrl,
        endpoint: "accounts/profile",
        body: {},
        cookieHeader,
      });
      const next = response?.profile ?? {};
      const nextAccountId = `${next.account_id ?? ""}`.trim();
      const expectedAccountId = `${profile?.account_id ?? ""}`.trim();
      if (
        expectedAccountId &&
        nextAccountId &&
        nextAccountId !== expectedAccountId
      ) {
        return {};
      }
      return {
        email_address: `${next.email_address ?? ""}`.trim() || null,
        first_name: `${next.first_name ?? ""}`.trim() || null,
        last_name: `${next.last_name ?? ""}`.trim() || null,
      };
    } catch {
      return {};
    }
  }

  auth
    .command("status")
    .description("show effective auth/profile status")
    .option("--check", "verify credentials by connecting to the configured hub")
    .action(async (opts: { check?: boolean }, command: Command) => {
      await runLocalCommand(command, "auth status", async (globals: any) => {
        const configPath = authConfigPath();
        const config = loadAuthConfig(configPath);
        const selected = selectedProfileName(globals, config);
        const profile = config.profiles[selected];
        const applied = applyAuthProfile(globals, config);
        const effective = applied.globals as any;
        const accountId =
          getExplicitAccountId(effective) ??
          (!effective.disableEnvAuthDefaults
            ? env.COCALC_ACCOUNT_ID
            : undefined) ??
          null;
        const apiBaseUrl = effective.api
          ? normalizeUrl(effective.api)
          : defaultApiBaseUrl();
        const allowEnvAuthDefaults = !effective.disableEnvAuthDefaults;
        const projectAuth = allowEnvAuthDefaults
          ? describeProjectScopedAuth(env)
          : {
              has_project_secret: false,
              has_project_id: false,
              has_project_scoped_auth: false,
              project_auth_source: null,
              project_id: null,
              project_auth_message: "no project-scoped auth detected",
            };
        const effective_remote_auth = effective.cookie
          ? "cookie"
          : (effective.bearer ??
              (allowEnvAuthDefaults ? env.COCALC_BEARER_TOKEN : undefined))
            ? "bearer"
            : (effective.apiKey ??
                (allowEnvAuthDefaults ? env.COCALC_API_KEY : undefined))
              ? "api_key"
              : normalizeSecretValue(
                    effective.hubPassword ??
                      (allowEnvAuthDefaults
                        ? env.COCALC_HUB_PASSWORD
                        : undefined),
                  )
                ? "hub_password"
                : projectAuth.has_project_scoped_auth
                  ? "project_scoped"
                  : "none";

        let check:
          | {
              ok: boolean;
              account_id?: string | null;
              project_id?: string | null;
              auth_actor?: string | null;
              auth_session_hash?: string | null;
              interactive_session?: boolean | null;
              auth_client?: string | null;
              factor_level?: string | null;
              fresh_auth_until?: string | null;
              session_expire?: string | null;
              error?: string;
            }
          | undefined;
        if (opts.check) {
          try {
            if (effective_remote_auth === "cookie") {
              const cookieHeader = buildCookieHeader(apiBaseUrl, effective);
              const profile = await postCliAuthApi<{
                profile?: {
                  account_id?: string | null;
                };
              }>({
                apiBaseUrl,
                endpoint: "accounts/profile",
                body: {},
                cookieHeader,
              });
              const sessionStatus = await postCliAuthApi<{
                auth_client?: string;
                factor_level?: string;
                fresh_auth_until?: string | Date | null;
                expire?: string | Date | null;
                auth_session_hash?: string | null;
              }>({
                apiBaseUrl,
                endpoint: "auth/cli/session-status",
                body: {},
                cookieHeader,
              });
              check = {
                ok: true,
                account_id:
                  `${profile?.profile?.account_id ?? ""}`.trim() || null,
                project_id: null,
                auth_actor: "account",
                auth_session_hash:
                  `${sessionStatus?.auth_session_hash ?? ""}`.trim() || null,
                interactive_session: true,
                auth_client: `${sessionStatus?.auth_client ?? "cli"}`,
              };
              check.factor_level =
                `${sessionStatus?.factor_level ?? ""}`.trim() || null;
              check.fresh_auth_until = sessionStatus?.fresh_auth_until
                ? new Date(sessionStatus.fresh_auth_until).toISOString()
                : null;
              check.session_expire = sessionStatus?.expire
                ? new Date(sessionStatus.expire).toISOString()
                : null;
            } else {
              const timeoutMs = durationToMs(effective.timeout, 15_000);
              const remote = await connectRemote({
                globals: effective,
                apiBaseUrl,
                timeoutMs,
              });
              check = {
                ok: true,
                account_id: resolveAccountIdFromRemote(remote) ?? null,
                project_id:
                  typeof remote.user?.project_id === "string"
                    ? remote.user.project_id
                    : null,
                auth_actor:
                  typeof remote.user?.auth_actor === "string"
                    ? remote.user.auth_actor
                    : null,
                auth_session_hash:
                  typeof (remote.user as any)?.auth_session_hash === "string"
                    ? (remote.user as any).auth_session_hash
                    : null,
                interactive_session: false,
              };
              remote.client.close();
            }
          } catch (err) {
            check = {
              ok: false,
              error: err instanceof Error ? err.message : `${err}`,
            };
          }
        }

        return {
          config_path: configPath,
          current_profile: config.current_profile ?? null,
          selected_profile: selected,
          profile_found: !!profile,
          using_profile_defaults: applied.fromProfile,
          profiles_count: Object.keys(config.profiles).length,
          api: apiBaseUrl,
          account_id: accountId,
          has_api_key: !!(
            effective.apiKey ??
            (allowEnvAuthDefaults ? env.COCALC_API_KEY : undefined)
          ),
          has_cookie: !!effective.cookie,
          has_bearer: !!(
            effective.bearer ??
            (allowEnvAuthDefaults ? env.COCALC_BEARER_TOKEN : undefined)
          ),
          has_hub_password: !!normalizeSecretValue(
            effective.hubPassword ??
              (allowEnvAuthDefaults ? env.COCALC_HUB_PASSWORD : undefined),
          ),
          ...projectAuth,
          effective_remote_auth,
          check: check ?? null,
        };
      });
    });

  auth
    .command("list")
    .description("list auth profiles")
    .action(async (command: Command) => {
      await runLocalCommand(command, "auth list", async () => {
        const configPath = authConfigPath();
        const config = loadAuthConfig(configPath);
        let changed = false;
        const rows = await Promise.all(
          Object.entries(config.profiles)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(async ([name, profile]: any) => {
              const identity = await maybeRefreshProfileIdentity(profile);
              if (
                (identity.email_address != null &&
                  identity.email_address !== profile.email_address) ||
                (identity.first_name != null &&
                  identity.first_name !== profile.first_name) ||
                (identity.last_name != null &&
                  identity.last_name !== profile.last_name)
              ) {
                config.profiles[name] = {
                  ...profile,
                  ...(identity.email_address != null
                    ? { email_address: identity.email_address }
                    : {}),
                  ...(identity.first_name != null
                    ? { first_name: identity.first_name }
                    : {}),
                  ...(identity.last_name != null
                    ? { last_name: identity.last_name }
                    : {}),
                };
                changed = true;
              }
              const nextProfile = config.profiles[name] ?? profile;
              return {
                profile: name,
                current: config.current_profile === name,
                api: nextProfile.api ?? null,
                account_id: nextProfile.account_id ?? null,
                email_address: nextProfile.email_address ?? null,
                first_name: nextProfile.first_name ?? null,
                last_name: nextProfile.last_name ?? null,
                api_key: maskSecret(nextProfile.api_key),
                cookie: maskSecret(nextProfile.cookie),
                bearer: maskSecret(nextProfile.bearer),
                hub_password: maskSecret(nextProfile.hub_password),
              };
            }),
        );
        if (changed) {
          saveAuthConfig(config, configPath);
        }
        return rows;
      });
    });

  async function saveAuthProfile(
    globals: any,
    opts: { setCurrent?: boolean },
  ): Promise<{
    profile: string;
    current_profile: string | null;
    stored: Record<string, unknown>;
  }> {
    const configPath = authConfigPath();
    const config = loadAuthConfig(configPath);
    const profileName = sanitizeProfileName(globals.profile);
    const patch = profileFromGlobals(globals);
    if (Object.keys(patch).length === 0) {
      throw new Error(
        "nothing to store; provide one of --api, --account-id, --api-key, --cookie, --bearer, --hub-password",
      );
    }
    const current = config.profiles[profileName] ?? {};
    const next: any = { ...current, ...patch };
    config.profiles[profileName] = next;
    if (opts.setCurrent !== false) {
      config.current_profile = profileName;
    }
    saveAuthConfig(config, configPath);
    return {
      profile: profileName,
      current_profile: config.current_profile ?? null,
      stored: {
        api: next.api ?? null,
        account_id: next.account_id ?? null,
        api_key: maskSecret(next.api_key),
        cookie: maskSecret(next.cookie),
        bearer: maskSecret(next.bearer),
        hub_password: maskSecret(next.hub_password),
      },
    };
  }

  function resolveEffectiveGlobals(globals: any): any {
    const configPath = authConfigPath();
    const config = loadAuthConfig(configPath);
    return applyAuthProfile(globals, config).globals;
  }

  async function runBrowserLogin(
    globals: any,
    opts: { email?: string; pollMs?: string; setCurrent?: boolean },
  ): Promise<Record<string, unknown>> {
    const effective = resolveEffectiveGlobals(globals);
    const email = await resolveBrowserLoginEmail(opts.email);
    let apiBaseUrl = effective.api
      ? normalizeUrl(effective.api)
      : defaultApiBaseUrl();
    let start = await postCliAuthApi<CliChallengeStart | any>({
      apiBaseUrl,
      endpoint: "auth/cli/login/start",
      body: { email },
    });
    if (start?.wrong_bay === true) {
      const homeBayUrl = `${start.home_bay_url ?? ""}`.trim();
      if (!homeBayUrl) {
        throw new Error("missing home bay url for CLI login");
      }
      apiBaseUrl = normalizeUrl(homeBayUrl);
      start = await postCliAuthApi<CliChallengeStart>({
        apiBaseUrl,
        endpoint: "auth/cli/login/start",
        body: { email, retry_token: start.retry_token },
      });
    }

    process.stderr.write(
      `Open this URL in your browser to approve CLI login:\n${start.approval_url}\n`,
    );

    const status = await waitForCliChallenge({
      apiBaseUrl,
      endpoint: "auth/cli/login/status",
      challenge_id: start.challenge_id,
      poll_token: start.poll_token,
      pollMs: Math.max(200, durationToMs(opts.pollMs, 1_500)),
    });
    if (status.state !== "approved" || !status.redeem_token) {
      throw new Error(`unexpected CLI login challenge state '${status.state}'`);
    }

    const redeemed = await postCliAuthApi<{
      account_id: string;
      remember_me: string;
      expire: string | Date;
      email_address?: string | null;
      first_name?: string | null;
      last_name?: string | null;
    }>({
      apiBaseUrl,
      endpoint: "auth/cli/login/redeem",
      body: {
        challenge_id: start.challenge_id,
        redeem_token: status.redeem_token,
      },
    });

    const configPath = authConfigPath();
    const config = loadAuthConfig(configPath);
    const profileName = sanitizeProfileName(globals.profile);
    const next = {
      ...(config.profiles[profileName] ?? {}),
      api: apiBaseUrl,
      account_id: redeemed.account_id,
      email_address:
        `${redeemed.email_address ?? ""}`.trim() || `${email}`.trim() || null,
      first_name: `${redeemed.first_name ?? ""}`.trim() || null,
      last_name: `${redeemed.last_name ?? ""}`.trim() || null,
      cookie: buildRememberMeCookieHeader(apiBaseUrl, redeemed.remember_me),
    };
    delete (next as any).api_key;
    delete (next as any).bearer;
    delete (next as any).hub_password;
    config.profiles[profileName] = next;
    if (opts.setCurrent !== false) {
      config.current_profile = profileName;
    }
    saveAuthConfig(config, configPath);
    return {
      profile: profileName,
      current_profile: config.current_profile ?? null,
      api: apiBaseUrl,
      account_id: redeemed.account_id,
      email_address: next.email_address,
      first_name: next.first_name,
      last_name: next.last_name,
      expires_at: new Date(redeemed.expire).toISOString(),
      interactive_session: true,
    };
  }

  auth
    .command("login")
    .description("sign in via browser approval or store explicit credentials")
    .option("--email <email>", "account email address for browser login")
    .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
    .option("--no-set-current", "do not set this profile as current")
    .addHelpText(
      "after",
      `
Examples:
  cocalc --profile alice --api https://lite4b.cocalc.ai auth login --email alice@example.com
  cocalc --profile bella --api https://lite4b.cocalc.ai auth login --email bella@example.com
`,
    )
    .action(
      async (
        opts: { email?: string; pollMs?: string; setCurrent?: boolean },
        command: Command,
      ) => {
        await runLocalCommand(command, "auth login", async (globals: any) => {
          if (hasLegacyStoredCredentials(globals)) {
            return await saveAuthProfile(globals, opts);
          }
          return await runBrowserLogin(globals, opts);
        });
      },
    );

  auth
    .command("setup")
    .description("alias for auth login")
    .option("--email <email>", "account email address for browser login")
    .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
    .option("--no-set-current", "do not set this profile as current")
    .addHelpText(
      "after",
      `
Examples:
  cocalc --profile alice --api https://lite4b.cocalc.ai auth setup --email alice@example.com
`,
    )
    .action(
      async (
        opts: { email?: string; pollMs?: string; setCurrent?: boolean },
        command: Command,
      ) => {
        await runLocalCommand(command, "auth setup", async (globals: any) => {
          if (hasLegacyStoredCredentials(globals)) {
            return await saveAuthProfile(globals, opts);
          }
          return await runBrowserLogin(globals, opts);
        });
      },
    );

  auth
    .command("elevate")
    .description("elevate the current CLI session via browser approval")
    .option("--extended", "keep this elevation active for 8 hours")
    .option(
      "--dev",
      "dev-only: elevate using the hub password instead of browser approval",
    )
    .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
    .action(
      async (
        opts: { extended?: boolean; dev?: boolean; pollMs?: string },
        command: Command,
      ) => {
        await runLocalCommand(command, "auth elevate", async (globals: any) => {
          const effective = resolveEffectiveGlobals(globals);
          const apiBaseUrl = effective.api
            ? normalizeUrl(effective.api)
            : defaultApiBaseUrl();
          const hubPassword =
            effective.hubPassword ??
            globals.hubPassword ??
            env.COCALC_HUB_PASSWORD;
          let cookieHeader = buildCookieHeader(
            apiBaseUrl,
            opts.dev
              ? {
                  ...effective,
                  hubPassword,
                  disableEnvAuthDefaults: false,
                }
              : effective,
          );
          let bootstrappedDevSession:
            | {
                value: string;
                account_id?: string | null;
                fresh_auth_until?: string | Date | null;
                factor_level?: string | null;
              }
            | undefined;
          if (opts.dev && !cookieHeaderHasRememberMe(cookieHeader)) {
            const requestedAccountId =
              getExplicitAccountId(effective) ??
              (!effective.disableEnvAuthDefaults
                ? env.COCALC_ACCOUNT_ID
                : undefined);
            if (!requestedAccountId) {
              throw new Error(
                "dev CLI elevation without an existing cookie requires --account-id or COCALC_ACCOUNT_ID",
              );
            }
            bootstrappedDevSession = await maybeCreateLocalDevRememberMeCookie({
              globals: {
                ...effective,
                hubPassword,
                disableEnvAuthDefaults: false,
              },
              apiBaseUrl,
              requestedAccountId,
              freshAuthDuration: opts.extended ? "extended" : "default",
            });
            if (!bootstrappedDevSession?.value) {
              throw new Error(
                "dev CLI elevation without an existing cookie requires local dev hub-password access",
              );
            }
            bootstrappedDevSession = {
              ...bootstrappedDevSession,
              account_id: requestedAccountId,
            };
            cookieHeader = buildCookieHeader(apiBaseUrl, {
              ...effective,
              cookie: buildRememberMeCookieHeader(
                apiBaseUrl,
                bootstrappedDevSession.value,
              ),
              hubPassword,
              disableEnvAuthDefaults: false,
            });
          }
          if (!cookieHeader) {
            throw new Error(
              "interactive CLI sign-in is required before elevation",
            );
          }
          if (opts.dev) {
            if (bootstrappedDevSession) {
              return {
                account_id:
                  (`${bootstrappedDevSession.account_id ?? ""}`.trim() ||
                    getExplicitAccountId(effective)) ??
                  null,
                factor_level:
                  `${bootstrappedDevSession.factor_level ?? "totp"}`.trim() ||
                  null,
                fresh_auth_until: bootstrappedDevSession.fresh_auth_until
                  ? new Date(
                      bootstrappedDevSession.fresh_auth_until,
                    ).toISOString()
                  : null,
                interactive_session: true,
                bootstrapped_session: true,
                dev: true,
              };
            }
            const status = await postCliAuthApi<{
              dev?: boolean;
              factor_level?: string;
              fresh_auth_until?: string | Date | null;
            }>({
              apiBaseUrl,
              endpoint: "auth/cli/elevate/dev",
              body: {
                duration: opts.extended ? "extended" : "default",
              },
              cookieHeader,
            });
            return {
              account_id: getExplicitAccountId(effective) ?? null,
              factor_level: `${status.factor_level ?? ""}`.trim() || null,
              fresh_auth_until: status.fresh_auth_until
                ? new Date(status.fresh_auth_until).toISOString()
                : null,
              interactive_session: true,
              dev: status.dev === true,
            };
          }
          const start = await postCliAuthApi<CliChallengeStart>({
            apiBaseUrl,
            endpoint: "auth/cli/elevate/start",
            body: {
              duration: opts.extended ? "extended" : "default",
            },
            cookieHeader,
          });
          process.stderr.write(
            `Open this URL in your browser to approve CLI elevation:\n${start.approval_url}\n`,
          );
          const status = await waitForCliChallenge({
            apiBaseUrl,
            endpoint: "auth/cli/elevate/status",
            challenge_id: start.challenge_id,
            poll_token: start.poll_token,
            pollMs: Math.max(200, durationToMs(opts.pollMs, 1_500)),
          });
          if (status.state !== "approved") {
            throw new Error(
              `unexpected CLI elevation challenge state '${status.state}'`,
            );
          }
          return {
            account_id: getExplicitAccountId(effective) ?? null,
            factor_level: `${status.factor_level ?? ""}`.trim() || null,
            fresh_auth_until: status.fresh_auth_until
              ? new Date(status.fresh_auth_until).toISOString()
              : null,
            interactive_session: true,
          };
        });
      },
    );

  auth
    .command("use <profile>")
    .description("set the current auth profile")
    .action(async (profileName: string, command: Command) => {
      await runLocalCommand(command, "auth use", async () => {
        const configPath = authConfigPath();
        const config = loadAuthConfig(configPath);
        const profile = sanitizeProfileName(profileName);
        if (!config.profiles[profile]) {
          throw new Error(`auth profile '${profile}' not found`);
        }
        config.current_profile = profile;
        saveAuthConfig(config, configPath);
        return {
          current_profile: profile,
        };
      });
    });

  auth
    .command("rename <from> <to>")
    .description("rename an auth profile")
    .action(async (fromName: string, toName: string, command: Command) => {
      await runLocalCommand(command, "auth rename", async () => {
        const configPath = authConfigPath();
        const config = loadAuthConfig(configPath);
        const from = sanitizeProfileName(fromName);
        const to = sanitizeProfileName(toName);
        if (!config.profiles[from]) {
          throw new Error(`auth profile '${from}' not found`);
        }
        if (from === to) {
          return {
            renamed: from,
            to,
            current_profile: config.current_profile ?? null,
          };
        }
        if (config.profiles[to]) {
          throw new Error(`auth profile '${to}' already exists`);
        }
        config.profiles[to] = config.profiles[from];
        delete config.profiles[from];
        if (config.current_profile === from) {
          config.current_profile = to;
        }
        saveAuthConfig(config, configPath);
        return {
          renamed: from,
          to,
          current_profile: config.current_profile ?? null,
        };
      });
    });

  auth
    .command("logout")
    .description("remove stored auth profile(s)")
    .option("--all", "remove all auth profiles")
    .option(
      "--target-profile <name>",
      "profile to remove (defaults to selected/current)",
    )
    .action(
      async (
        opts: { all?: boolean; targetProfile?: string },
        command: Command,
      ) => {
        await runLocalCommand(command, "auth logout", async (globals: any) => {
          const configPath = authConfigPath();
          const config = loadAuthConfig(configPath);

          if (opts.all) {
            config.profiles = {};
            config.current_profile = undefined;
            saveAuthConfig(config, configPath);
            return {
              removed: "all",
              current_profile: null,
              remaining_profiles: 0,
            };
          }

          const target = sanitizeProfileName(
            opts.targetProfile ?? globals.profile ?? config.current_profile,
          );
          if (!config.profiles[target]) {
            throw new Error(`auth profile '${target}' not found`);
          }
          delete config.profiles[target];
          if (config.current_profile === target) {
            const next = Object.keys(config.profiles).sort()[0];
            config.current_profile = next;
          }
          saveAuthConfig(config, configPath);
          return {
            removed: target,
            current_profile: config.current_profile ?? null,
            remaining_profiles: Object.keys(config.profiles).length,
          };
        });
      },
    );

  return auth;
}
