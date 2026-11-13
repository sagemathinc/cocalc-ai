// Client-side record of the last session/fresh-auth grant per auth profile.
//
// These are server-returned expiry timestamps only (no token, cookie, hash or
// length of any secret). They are informational: nothing may read them to
// decide anything (whether to elevate, which credential to use, whether to
// prompt). The only reader is `auth status`. They live in a sidecar next to
// the config file (one per config) so recording a grant never rewrites the
// credential file;
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
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { applyPrivateMode } from "./platform-paths";

const DIR_MODE = 0o700;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
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

// One sidecar per config file (two configs in one directory never share
// records): <config name without .json>.auth-grants.json.
export function authGrantsPath(configPath: string): string {
  const name = basename(configPath).replace(/\.json$/i, "");
  return join(dirname(configPath), `${name}.auth-grants.json`);
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serializes the whole read/patch/write across processes with an exclusive
// lock file. A lock older than LOCK_STALE_MS (a crashed writer) is removed.
// Returns false if the lock could not be taken in time; the caller then
// skips the update (records are informational only).
function withLock(path: string, fn: () => void): boolean {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx", FILE_MODE);
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // the lock went away meanwhile
      }
      if (Date.now() >= deadline) return false;
      sleepSync(25);
    }
  }
  try {
    fn();
    return true;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
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
  if (!existsSync(path)) return Object.create(null);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const grants = parsed?.grants;
    if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
      return Object.create(null);
    }
    // Null prototype: profile names such as "__proto__" or "constructor" are
    // valid and must be plain keys.
    const out: Record<string, AuthGrantRecord> = Object.create(null);
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
    return Object.create(null);
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
  const tmp = join(
    dir,
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
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
// The sidecar is re-read here, under an exclusive lock, immediately before
// each write, and only the given profile's entry is changed, so a record
// written by another CLI process (during a long browser approval wait, or
// at the same moment) is kept.
function update(
  configPath: string,
  fn: (grants: Record<string, AuthGrantRecord>) => boolean,
): void {
  try {
    const path = authGrantsPath(configPath);
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    const done = withLock(path, () => {
      const grants = readGrants(configPath);
      if (fn(grants)) writeGrants(configPath, grants);
    });
    if (!done) throw new Error("lock busy");
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
// `stillCurrent` is checked under the sidecar lock, right before writing: if
// the profile's session changed while waiting for approval (a re-login or a
// logout), the result belongs to the old session and nothing is recorded.
export function recordFreshAuth(
  configPath: string,
  profile: string,
  grant: { api: unknown; fresh_auth_until: unknown },
  now: Date = new Date(),
  stillCurrent: () => boolean = () => true,
): void {
  const api = apiOrigin(grant.api);
  update(configPath, (grants) => {
    if (!stillCurrent()) return false;
    if (!api) {
      delete grants[profile];
      return true;
    }
    const prior = hasOwn(grants, profile) ? grants[profile] : undefined;
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
      if (hasOwn(grants, name)) {
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
    const record = hasOwn(grants, from) ? grants[from] : undefined;
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
  const grants = readGrants(configPath);
  const record = hasOwn(grants, profile) ? grants[profile] : undefined;
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
