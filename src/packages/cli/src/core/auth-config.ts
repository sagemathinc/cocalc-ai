import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AuthProfile = {
  api?: string;
  account_id?: string;
  api_key?: string;
  cookie?: string;
  bearer?: string;
  hub_password?: string;
  browser_id?: string;
};

export type AuthConfig = {
  current_profile?: string;
  profiles: Record<string, AuthProfile>;
};

export type GlobalAuthOptions = {
  profile?: string;
  api?: string;
  accountId?: string;
  account_id?: string;
  apiKey?: string;
  cookie?: string;
  bearer?: string;
  hubPassword?: string;
};

const DEFAULT_PROFILE = "default";

export function authConfigPath(env = process.env): string {
  const explicit = env.COCALC_CLI_CONFIG?.trim();
  if (explicit) return explicit;
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "cocalc", "config.json");
}

export function sanitizeProfileName(name: string | undefined): string {
  const candidate = `${name ?? ""}`.trim() || DEFAULT_PROFILE;
  if (!/^[a-zA-Z0-9._-]+$/.test(candidate)) {
    throw new Error(
      `invalid profile name '${candidate}' (allowed: letters, numbers, dot, underscore, dash)`,
    );
  }
  return candidate;
}

export function loadAuthConfig(path = authConfigPath()): AuthConfig {
  if (!existsSync(path)) return { profiles: {} };
  const text = readFileSync(path, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid auth config JSON at ${path}: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid auth config at ${path}: expected object`);
  }

  const profilesRaw = parsed.profiles;
  const profiles: Record<string, AuthProfile> = {};
  if (profilesRaw && typeof profilesRaw === "object" && !Array.isArray(profilesRaw)) {
    for (const [name, value] of Object.entries(profilesRaw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      profiles[name] = value as AuthProfile;
    }
  }

  const current_profile =
    typeof parsed.current_profile === "string" && parsed.current_profile.trim()
      ? parsed.current_profile.trim()
      : undefined;

  return { current_profile, profiles };
}

export function saveAuthConfig(config: AuthConfig, path = authConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: AuthConfig = {
    current_profile: config.current_profile,
    profiles: config.profiles ?? {},
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function selectedProfileName(
  globals: Pick<GlobalAuthOptions, "profile">,
  config: AuthConfig,
  env = process.env,
): string {
  return sanitizeProfileName(globals.profile ?? env.COCALC_PROFILE ?? config.current_profile);
}

export function applyAuthProfile(
  globals: GlobalAuthOptions,
  config: AuthConfig,
  env = process.env,
): { globals: GlobalAuthOptions; profile: string; fromProfile: boolean } {
  const profile = selectedProfileName(globals, config, env);
  const data = config.profiles[profile];
  if (!data) {
    return { globals: { ...globals }, profile, fromProfile: false };
  }

  const resolved: GlobalAuthOptions = { ...globals };
  if (!resolved.api && !env.COCALC_API_URL && data.api) {
    resolved.api = data.api;
  }
  if (!resolved.accountId && !resolved.account_id && !env.COCALC_ACCOUNT_ID && data.account_id) {
    resolved.accountId = data.account_id;
  }
  if (!resolved.apiKey && !env.COCALC_API_KEY && data.api_key) {
    resolved.apiKey = data.api_key;
  }
  if (!resolved.cookie && data.cookie) {
    resolved.cookie = data.cookie;
  }
  if (!resolved.bearer && !env.COCALC_BEARER_TOKEN && data.bearer) {
    resolved.bearer = data.bearer;
  }
  if (!resolved.hubPassword && !env.COCALC_HUB_PASSWORD && data.hub_password) {
    resolved.hubPassword = data.hub_password;
  }
  return { globals: resolved, profile, fromProfile: true };
}
