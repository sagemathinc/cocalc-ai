import { Command } from "commander";

export type AuthCommandDeps = {
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
  normalizeSecretValue: any;
  maskSecret: any;
  sanitizeProfileName: any;
  profileFromGlobals: any;
  saveAuthConfig: any;
};

export function registerAuthCommand(program: Command, deps: AuthCommandDeps): Command {
  const {
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
    normalizeSecretValue,
    maskSecret,
    sanitizeProfileName,
    profileFromGlobals,
    saveAuthConfig,
  } = deps;

  const auth = program.command("auth").description("auth profile management");

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
        const accountId = getExplicitAccountId(effective) ?? process.env.COCALC_ACCOUNT_ID ?? null;
        const apiBaseUrl = effective.api ? normalizeUrl(effective.api) : defaultApiBaseUrl();

        let check: { ok: boolean; account_id?: string | null; error?: string } | undefined;
        if (opts.check) {
          try {
            const timeoutMs = durationToMs(effective.timeout, 15_000);
            const remote = await connectRemote({ globals: effective, apiBaseUrl, timeoutMs });
            check = {
              ok: true,
              account_id: resolveAccountIdFromRemote(remote) ?? null,
            };
            remote.client.close();
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
          has_api_key: !!(effective.apiKey ?? process.env.COCALC_API_KEY),
          has_cookie: !!effective.cookie,
          has_bearer: !!(effective.bearer ?? process.env.COCALC_BEARER_TOKEN),
          has_hub_password: !!normalizeSecretValue(
            effective.hubPassword ?? process.env.COCALC_HUB_PASSWORD,
          ),
          check: check ?? null,
        };
      });
    });

  auth
    .command("list")
    .description("list auth profiles")
    .action(async (command: Command) => {
      await runLocalCommand(command, "auth list", async () => {
        const config = loadAuthConfig();
        return Object.entries(config.profiles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, profile]: any) => ({
            profile: name,
            current: config.current_profile === name,
            api: profile.api ?? null,
            account_id: profile.account_id ?? null,
            api_key: maskSecret(profile.api_key),
            cookie: maskSecret(profile.cookie),
            bearer: maskSecret(profile.bearer),
            hub_password: maskSecret(profile.hub_password),
          }));
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

  auth
    .command("login")
    .description("store credentials in an auth profile")
    .option("--no-set-current", "do not set this profile as current")
    .action(async (opts: { setCurrent?: boolean }, command: Command) => {
      await runLocalCommand(command, "auth login", async (globals: any) => {
        return await saveAuthProfile(globals, opts);
      });
    });

  auth
    .command("setup")
    .description("alias for auth login")
    .option("--no-set-current", "do not set this profile as current")
    .action(async (opts: { setCurrent?: boolean }, command: Command) => {
      await runLocalCommand(command, "auth setup", async (globals: any) => {
        return await saveAuthProfile(globals, opts);
      });
    });

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
    .command("logout")
    .description("remove stored auth profile(s)")
    .option("--all", "remove all auth profiles")
    .option("--target-profile <name>", "profile to remove (defaults to selected/current)")
    .action(async (opts: { all?: boolean; targetProfile?: string }, command: Command) => {
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
    });

  return auth;
}
