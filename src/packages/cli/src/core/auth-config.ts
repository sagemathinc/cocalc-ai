import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { applyPrivateMode, cocalcCliConfigDir } from "./platform-paths";

export type AuthProfile = {
  host_ssh_network?: "private" | "public" | "auto";
  api?: string;
  account_id?: string;
  email_address?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  api_key?: string;
  cookie?: string;
  bearer?: string;
  hub_password?: string;
  browser_id?: string;
  // Optional per-API browser defaults keyed by normalized API origin.
  browser_ids_by_api?: Record<string, string>;
};

export type AuthConfig = {
  current_profile?: string;
  profiles: Record<string, AuthProfile>;
};

export type GlobalAuthOptions = {
  hostSshNetwork?: "private" | "public" | "auto";
  profile?: string;
  api?: string;
  accountId?: string;
  account_id?: string;
  apiKey?: string;
  apiKeyFile?: string;
  cookie?: string;
  bearer?: string;
  hubPassword?: string;
  disableEnvAuthDefaults?: boolean;
  // Preserve credential provenance when a daemon freezes environment defaults.
  directAuthSite?: string;
};

const DEFAULT_PROFILE = "default";
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
export const ENV_AUTH_PROFILE = "_env";
const ENV_AUTH_PROFILE_ALIASES = new Set([ENV_AUTH_PROFILE, "env"]);

export function isEnvAuthProfileName(name: string | undefined): boolean {
  const candidate = `${name ?? ""}`.trim();
  return ENV_AUTH_PROFILE_ALIASES.has(candidate);
}

function normalizeApiScope(value: string | undefined): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(
      raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : `http://${raw}`,
    );
    return url.origin;
  } catch {
    return undefined;
  }
}

export function authConfigPath(env = process.env): string {
  const explicit = env.COCALC_CLI_CONFIG?.trim();
  if (explicit) return explicit;
  return join(cocalcCliConfigDir({ env }), "config.json");
}

export function sanitizeProfileName(name: string | undefined): string {
  const candidate = `${name ?? ""}`.trim() || DEFAULT_PROFILE;
  if (isEnvAuthProfileName(candidate)) {
    throw new Error(
      `profile name '${candidate}' is reserved for environment-based auth`,
    );
  }
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
  if (
    profilesRaw &&
    typeof profilesRaw === "object" &&
    !Array.isArray(profilesRaw)
  ) {
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

export function saveAuthConfig(
  config: AuthConfig,
  path = authConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: CONFIG_DIR_MODE });
  const payload: AuthConfig = {
    current_profile: config.current_profile,
    profiles: config.profiles ?? {},
  };
  writeFileAtomically(path, `${JSON.stringify(payload, null, 2)}\n`);
}

// The config file holds every profile's credentials, so it is never written
// in place: a crash, a short write or a full disk must not truncate it. Write
// a private temp file in the same directory (every byte, then fsync), then
// rename it over the file. A symlinked config keeps its link: the rename
// replaces the link's final target (also when that target does not exist
// yet). Any error other than "does not exist" aborts without touching the
// config. A hard-linked config loses its other links on the rename (they keep
// the old contents); a symlink is the supported way to share one.
const MAX_LINKS = 40;

function isNotFound(err: any): boolean {
  return err?.code === "ENOENT";
}

function resolveWriteTarget(path: string): string {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (isNotFound(err)) return path; // a new config file
    throw err;
  }
  if (!st.isSymbolicLink()) return path;
  try {
    return realpathSync(path);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  // A dangling link (possibly a chain): follow it by hand to the missing
  // final target, so the atomic write creates that target.
  let current = path;
  for (let i = 0; i < MAX_LINKS; i++) {
    let cur;
    try {
      cur = lstatSync(current);
    } catch (err) {
      if (isNotFound(err)) return current;
      throw err;
    }
    if (!cur.isSymbolicLink()) return realpathSync(current);
    current = resolve(dirname(current), readlinkSync(current));
  }
  const err: any = new Error(`too many symbolic links: ${path}`);
  err.code = "ELOOP";
  throw err;
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (!(n > 0)) {
      throw new Error("auth config write made no progress");
    }
    offset += n;
  }
}

function writeFileAtomically(path: string, text: string): void {
  const target = resolveWriteTarget(path);
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", CONFIG_FILE_MODE);
    try {
      writeAll(fd, text);
      fsyncSync(fd);
      const size = fstatSync(fd).size;
      if (size !== Buffer.byteLength(text, "utf8")) {
        throw new Error(
          `auth config temp file is ${size} bytes, expected more`,
        );
      }
    } finally {
      closeSync(fd);
    }
    applyPrivateMode(tmp, CONFIG_FILE_MODE);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function selectedProfileName(
  globals: Pick<GlobalAuthOptions, "profile">,
  config: AuthConfig,
  env = process.env,
): string {
  const candidate =
    globals.profile ??
    env.COCALC_PROFILE ??
    (env.COCALC_CLI_AGENT_MODE === "1"
      ? ENV_AUTH_PROFILE
      : config.current_profile);
  if (isEnvAuthProfileName(candidate)) {
    return ENV_AUTH_PROFILE;
  }
  return sanitizeProfileName(candidate);
}

export function applyAuthProfile(
  globals: GlobalAuthOptions,
  config: AuthConfig,
  env = process.env,
): { globals: GlobalAuthOptions; profile: string; fromProfile: boolean } {
  const profile = selectedProfileName(globals, config, env);
  if (profile === ENV_AUTH_PROFILE) {
    return { globals: { ...globals }, profile, fromProfile: false };
  }
  const data = config.profiles[profile];
  if (!data) {
    return { globals: { ...globals }, profile, fromProfile: false };
  }

  const resolved: GlobalAuthOptions = { ...globals };
  const requestedApiScope = normalizeApiScope(globals.api);
  const profileApiScope = normalizeApiScope(data.api);
  const allowSecretInheritance =
    !requestedApiScope ||
    !profileApiScope ||
    requestedApiScope === profileApiScope;
  if (!resolved.api && data.api) {
    resolved.api = data.api;
  }
  if (allowSecretInheritance && !resolved.hostSshNetwork) {
    resolved.hostSshNetwork = data.host_ssh_network;
  }
  if (
    allowSecretInheritance &&
    !resolved.accountId &&
    !resolved.account_id &&
    data.account_id
  ) {
    resolved.accountId = data.account_id;
  }
  if (
    allowSecretInheritance &&
    !resolved.apiKey &&
    !resolved.apiKeyFile &&
    data.api_key
  ) {
    resolved.apiKey = data.api_key;
  }
  if (allowSecretInheritance && !resolved.cookie && data.cookie) {
    resolved.cookie = data.cookie;
  }
  if (allowSecretInheritance && !resolved.bearer && data.bearer) {
    resolved.bearer = data.bearer;
  }
  if (allowSecretInheritance && !resolved.hubPassword && data.hub_password) {
    resolved.hubPassword = data.hub_password;
  }
  resolved.disableEnvAuthDefaults = true;
  return { globals: resolved, profile, fromProfile: true };
}
