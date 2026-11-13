// Client-side record of the last session/fresh-auth grant per auth profile.
//
// These are server-returned expiry timestamps only (no token, cookie, hash or
// length of any secret). They are informational: nothing may read them to
// decide anything (whether to elevate, which credential to use, whether to
// prompt). The only reader is `auth status`. They live in a sidecar next to
// config.json so that recording a grant never rewrites the credential file;
// a missing or corrupt sidecar only loses the records.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { applyPrivateMode } from "./platform-paths";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type AuthGrantRecord = {
  // Origin of the API the grant came from; a record never describes another
  // site's session.
  api: string;
  recorded_at: string;
  session_expires_at: string | null;
  fresh_auth_until: string | null;
};

type AuthGrantsFile = {
  version: 1;
  grants: Record<string, AuthGrantRecord>;
};

export function authGrantsPath(configPath: string): string {
  return join(dirname(configPath), "auth-grants.json");
}

export function apiOrigin(api: unknown): string | null {
  const raw = `${api ?? ""}`.trim();
  if (!raw) return null;
  try {
    return new URL(
      raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : `http://${raw}`,
    ).origin;
  } catch {
    return null;
  }
}

// Server timestamp -> ISO string, or null for missing/invalid values (never
// "Invalid Date").
export function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readGrants(configPath: string): Record<string, AuthGrantRecord> {
  const path = authGrantsPath(configPath);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const grants = parsed?.grants;
    if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
      return {};
    }
    const out: Record<string, AuthGrantRecord> = {};
    for (const [name, value] of Object.entries(grants)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const v = value as any;
      const api = apiOrigin(v.api);
      if (!api) continue;
      out[name] = {
        api,
        recorded_at: isoOrNull(v.recorded_at) ?? "",
        session_expires_at: isoOrNull(v.session_expires_at),
        fresh_auth_until: isoOrNull(v.fresh_auth_until),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeGrants(
  configPath: string,
  grants: Record<string, AuthGrantRecord>,
): void {
  const path = authGrantsPath(configPath);
  if (Object.keys(grants).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const payload: AuthGrantsFile = { version: 1, grants };
  const tmp = join(dir, `.auth-grants.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", FILE_MODE);
    try {
      writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    applyPrivateMode(tmp, FILE_MODE);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Best effort: a failure to record must never fail the login/elevate itself.
// The sidecar is re-read here, immediately before each write, and only the
// given profile's entry is changed, so a record written by another CLI
// process during a long browser approval wait is kept.
function update(
  configPath: string,
  fn: (grants: Record<string, AuthGrantRecord>) => boolean,
): void {
  try {
    const grants = readGrants(configPath);
    if (fn(grants)) writeGrants(configPath, grants);
  } catch {
    process.stderr.write(
      "warning: could not update the local auth grant record (informational only; auth itself is unaffected)\n",
    );
  }
}

// A new session for this profile (login): replaces any earlier record.
export function recordSessionGrant(
  configPath: string,
  profile: string,
  grant: {
    api: unknown;
    session_expires_at: unknown;
    fresh_auth_until: unknown;
  },
  now: Date = new Date(),
): void {
  const api = apiOrigin(grant.api);
  update(configPath, (grants) => {
    if (!api) {
      delete grants[profile];
      return true;
    }
    grants[profile] = {
      api,
      recorded_at: now.toISOString(),
      session_expires_at: isoOrNull(grant.session_expires_at),
      fresh_auth_until: isoOrNull(grant.fresh_auth_until),
    };
    return true;
  });
}

// A fresh-auth result for the existing session (elevate). The session expiry
// is kept only if the record is for the same site; a null value (failed or
// unknown elevation) clears the recorded fresh-auth window.
export function recordFreshAuth(
  configPath: string,
  profile: string,
  grant: { api: unknown; fresh_auth_until: unknown },
  now: Date = new Date(),
): void {
  const api = apiOrigin(grant.api);
  update(configPath, (grants) => {
    if (!api) {
      delete grants[profile];
      return true;
    }
    const prior = grants[profile];
    grants[profile] = {
      api,
      recorded_at: now.toISOString(),
      session_expires_at:
        prior && prior.api === api ? prior.session_expires_at : null,
      fresh_auth_until: isoOrNull(grant.fresh_auth_until),
    };
    return true;
  });
}

export function clearAuthGrants(configPath: string, profiles: string[]): void {
  update(configPath, (grants) => {
    let changed = false;
    for (const name of profiles) {
      if (name in grants) {
        delete grants[name];
        changed = true;
      }
    }
    return changed;
  });
}

export function renameAuthGrant(
  configPath: string,
  from: string,
  to: string,
): void {
  update(configPath, (grants) => {
    const record = grants[from];
    delete grants[to];
    delete grants[from];
    if (record) grants[to] = record;
    return true;
  });
}

const RECORDED_NOTE =
  "last grant recorded by this CLI config on this machine; the server may end access earlier " +
  "(logout, revocation), and a login or elevate made elsewhere does not update it; " +
  "remaining seconds use the local clock (skew not corrected); null means unknown";

function remainingSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = new Date(iso).valueOf();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - nowMs) / 1000));
}

// The `auth status` view. A record is shown only for the profile it was made
// for and only while that profile still points at the same site.
export function recordedAuthStatus(
  configPath: string,
  profile: string,
  profileApi: unknown,
  now: Date = new Date(),
): Record<string, unknown> {
  const record = readGrants(configPath)[profile];
  const api = apiOrigin(profileApi);
  const applies = !!record && !!api && record.api === api;
  const nowMs = now.valueOf();
  return {
    recorded_at: applies ? record.recorded_at || null : null,
    recorded_session_expires_at: applies ? record.session_expires_at : null,
    recorded_fresh_auth_until: applies ? record.fresh_auth_until : null,
    computed_at: now.toISOString(),
    session_remaining_s: applies
      ? remainingSeconds(record.session_expires_at, nowMs)
      : null,
    fresh_auth_remaining_s: applies
      ? remainingSeconds(record.fresh_auth_until, nowMs)
      : null,
    recorded_note: RECORDED_NOTE,
  };
}
