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
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  lstatSync,
  rmSync,
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
// records): the config file's full name plus ".auth-grants.json", so "a",
// "a.json" and "a.JSON" each get their own.
export function authGrantsPath(configPath: string): string {
  return join(dirname(configPath), `${basename(configPath)}.auth-grants.json`);
}

const LOCK_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One writeSync is one write(2), which may write fewer bytes than asked (a
// full disk, a file-size limit) without an error. Write every byte, refuse a
// write that makes no progress, fsync, and check the size, so a short file is
// an error instead of a truncated sidecar or lock token.
function writeAllAndSync(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (!(n > 0)) {
      throw new Error("auth grant write made no progress");
    }
    offset += n;
  }
  fsyncSync(fd);
  const size = fstatSync(fd).size;
  if (size !== buf.length) {
    throw new Error(`auth grant file is ${size} bytes, expected ${buf.length}`);
  }
}

// Serializes the whole read/patch/write across processes with an exclusive
// lock file holding a random owner token. There is no time-based takeover: a
// lock's age does not show that its owner is gone (it may be paused). If the
// lock cannot be taken in time, the caller skips the update with a warning
// naming the lock file (records are informational only). The owner removes
// the lock only while it still holds its own token.
function withLock(path: string, fn: () => void): "done" | "busy" {
  const lock = `${path}.lock`;
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx", FILE_MODE);
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) return "busy";
      sleepSync(25);
    }
  }
  // The lock is ours from here. If writing the token fails (full disk, file
  // size limit), remove it again: no one ever takes over a lock by age, so a
  // lock left behind here would block every later update.
  const ours = fstatSync(fd);
  try {
    writeAllAndSync(fd, token);
  } catch (err) {
    closeSync(fd);
    try {
      const now = lstatSync(lock);
      if (now.dev === ours.dev && now.ino === ours.ino) {
        rmSync(lock, { force: true });
      }
    } catch {
      // already gone
    }
    throw err;
  }
  closeSync(fd);
  try {
    fn();
    return "done";
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // already gone
    }
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

// True if nothing is at `path` or it is one of these sidecars. Anything else
// (for example another CLI config file that happens to have this name) is
// never replaced or removed.
function safeToReplace(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return (
      !!parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.version === 1 &&
      !!parsed.grants &&
      typeof parsed.grants === "object" &&
      !Array.isArray(parsed.grants) &&
      Object.keys(parsed).every((k) => k === "version" || k === "grants")
    );
  } catch {
    return false;
  }
}

function writeGrants(
  configPath: string,
  grants: Record<string, AuthGrantRecord>,
): void {
  const path = authGrantsPath(configPath);
  if (!safeToReplace(path)) {
    throw new Error("not a grant record file");
  }
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
      writeAllAndSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
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
    const result = withLock(path, () => {
      const grants = readGrants(configPath);
      if (fn(grants)) writeGrants(configPath, grants);
    });
    if (result === "busy") {
      process.stderr.write(
        `warning: could not update the local auth grant record: ${path}.lock is held ` +
          "(another cocalc CLI is writing it; if none is running, remove that file). " +
          "Informational only; auth itself is unaffected.\n",
      );
    }
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
  "remaining seconds use the local clock (skew not corrected); null means unknown; " +
  "if recorded_lock_present_since is set, the record may be stale (a writer holds or left the lock)";

function lockSince(configPath: string): string | null {
  try {
    const { mtime } = lstatSync(`${authGrantsPath(configPath)}.lock`);
    return mtime.toISOString();
  } catch {
    return null;
  }
}

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
    // A lock left by a crashed writer freezes the record: say so.
    recorded_lock_present_since: lockSince(configPath),
    recorded_note: RECORDED_NOTE,
  };
}
