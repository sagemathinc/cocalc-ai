/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project app origins (trust-free step 6, phase 7).

A web server or app running in a project is served on its own origin under
the content domain, one origin per app:

  https://a<key>-<project32>.h-<host32>.<content domain>/<project_id>/...

- key = p<port> for /port/<n> and /proxy/<n>, or s<hash10> for a named
  server or an app, so a collaborator's static server (which may serve
  collected student HTML) never shares an origin with the same project's
  JupyterLab.
- The browser gets there through a short-lived, single-use app capability
  (this file), redeemed by the host at /_a/<capability> for a session cookie
  on that origin.

The capability is its own token type: a different version, audience and
claim set from content (file) capabilities, so neither is ever accepted as
the other.
*/

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from "crypto";
import { isValidUUID } from "@cocalc/util/misc";

const TOKEN_TYPE = "JWT";
const TOKEN_ALG = "EdDSA";
const APP_TOKEN_VERSION = "pca-v1";
const CLAIM_KEYS_REQUIRED = "aud,epoch,exp,hid,iat,iss,jti,key,scope,sub,v";
const CLAIM_KEYS_RESTRICTED = "aud,bse,epoch,exp,hid,iat,iss,jti,key,scope,sub,v";
const CLOCK_TOLERANCE_SECONDS = 30;

// Long enough for the browser to follow the hub's redirect, short enough
// that a link in history or a log is useless.
export const PROJECT_APP_CAPABILITY_TTL_SECONDS = 120;

// The key of an app origin: the port of /port/<n> and /proxy/<n>, else a
// short hash of the server or app name.
export type ProjectAppRoute =
  | { kind: "port"; port: number }
  | { kind: "server"; name: string }
  | { kind: "app"; id: string };

const APP_KEY_RE = /^(?:p[1-9][0-9]{0,4}|s[0-9a-f]{10})$/;

export function isProjectAppKey(key: unknown): key is string {
  if (typeof key !== "string" || !APP_KEY_RE.test(key)) return false;
  if (key.startsWith("p")) {
    const port = Number(key.slice(1));
    return port >= 1 && port <= 65535;
  }
  return true;
}

export function projectAppKey(route: ProjectAppRoute): string {
  if (route.kind === "port") {
    if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
      throw new Error("invalid app port");
    }
    return `p${route.port}`;
  }
  const name = route.kind === "server" ? route.name : route.id;
  if (typeof name !== "string" || !name || name.length > 256) {
    throw new Error("invalid app name");
  }
  return `s${createHash("sha256").update(`${route.kind}:${name}`).digest("hex").slice(0, 10)}`;
}

// The route a request path names, if it is one of the fixed app route forms
// (/<project_id>/port|proxy/<n>/..., /server/<name>/..., /apps/<id>/...).
// Apps mounted at their own base_path are resolved by the host instead.
export function projectAppRouteFromPath(
  project_id: string,
  pathname: string,
): ProjectAppRoute | undefined {
  const prefix = `/${project_id}/`;
  if (!pathname.startsWith(prefix)) return;
  const [kind, name] = pathname.slice(prefix.length).split("/");
  if (!name) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return;
  }
  if (kind === "port" || kind === "proxy") {
    if (/^[1-9][0-9]{0,4}$/.test(decoded)) {
      const port = Number(decoded);
      return port <= 65535 ? { kind: "port", port } : undefined;
    }
    // A named server at /port/<name> (one that uses its base path) is the
    // same app as /server/<name>.
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(decoded)) {
      return { kind: "server", name: decoded };
    }
    return;
  }
  if (kind === "server") return { kind: "server", name: decoded };
  if (kind === "apps") return { kind: "app", id: decoded };
  return;
}

const MAX_APP_PATH_LENGTH = 4096;

// The path (and query) an app link opens, normalized: it must be in this
// project's app namespace, with no dot segments, encoded slashes or
// backslashes; the hub checks it before signing, and the host again before redirecting.
export function normalizeProjectAppPath(
  project_id: string,
  path: unknown,
): string {
  const raw = `${path ?? ""}`;
  const q = raw.indexOf("?");
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q);
  if (
    raw.length > MAX_APP_PATH_LENGTH ||
    !pathname.startsWith(`/${project_id}/`) ||
    pathname.includes("//") ||
    /[\\#\u0000-\u001f\u007f]/.test(raw) ||
    /%2f|%5c|%00/i.test(pathname) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..") ||
    pathname.startsWith(`/${project_id}/files/`) ||
    pathname === `/${project_id}/upload`
  ) {
    throw new Error("invalid app path");
  }
  return `${pathname}${query}`;
}

export function projectAppHostLabel({
  project_id,
  key,
}: {
  project_id: string;
  key: string;
}): string {
  if (!isValidUUID(project_id) || !isProjectAppKey(key)) {
    throw new Error("invalid app origin");
  }
  return `a${key}-${project_id.replace(/-/g, "").toLowerCase()}`;
}

// The inverse of projectAppHostLabel, or undefined.
export function parseProjectAppHostLabel(
  label: string,
): { project_id: string; key: string } | undefined {
  const m = /^a(p[1-9][0-9]{0,4}|s[0-9a-f]{10})-([0-9a-f]{32})$/.exec(label);
  if (!m || !isProjectAppKey(m[1])) return;
  const hex = m[2];
  const project_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isValidUUID(project_id) ? { project_id, key: m[1] } : undefined;
}

// "app": a top-level session on the app's origin (/_a/); "app-frame": a
// session for the app framed by the site (/_af/).  Each scope has its own
// audience, so neither capability is ever accepted as the other.
export type ProjectAppScope = "app" | "app-frame";

export function projectAppAudience(
  project_id: string,
  key: string,
  scope: ProjectAppScope = "app",
): string {
  if (scope === "app-frame") return `project-app-frame:${project_id}:${key}`;
  return `project-app:${project_id}:${key}`;
}

export interface ProjectAppCapabilityClaims {
  iss: string;
  sub: string; // account_id
  aud: string; // project-app:<project_id>:<key>
  hid: string; // host_id
  key: string;
  epoch: number;
  scope: ProjectAppScope;
  // A restricted (testing) browser session's expiry: the app session must
  // not outlive it.
  bse?: number;
  iat: number;
  exp: number;
  jti: string;
  v: string;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error("invalid capability encoding");
  }
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  return Buffer.from(
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen),
    "base64",
  );
}

const isEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export function issueProjectAppCapability({
  project_id,
  host_id,
  account_id,
  key,
  epoch,
  private_key,
  browser_session_exp_s,
  scope = "app",
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: {
  project_id: string;
  host_id: string;
  account_id: string;
  key: string;
  epoch: number;
  private_key: string;
  browser_session_exp_s?: number;
  scope?: ProjectAppScope;
  issuer?: string;
  now_ms?: number;
}): { token: string; expires_at: number; claims: ProjectAppCapabilityClaims } {
  if (
    !isValidUUID(project_id) ||
    !isValidUUID(host_id) ||
    !isValidUUID(account_id) ||
    !isProjectAppKey(key)
  ) {
    throw new Error("invalid app capability identity");
  }
  if (!isEpoch(epoch)) throw new Error("invalid content epoch");
  if (scope !== "app" && scope !== "app-frame") {
    throw new Error("invalid app capability scope");
  }
  const iat = Math.floor(now_ms / 1000);
  if (
    browser_session_exp_s != null &&
    !(Number.isSafeInteger(browser_session_exp_s) && browser_session_exp_s > iat)
  ) {
    throw new Error("browser session expired");
  }
  const claims: ProjectAppCapabilityClaims = {
    iss: issuer,
    sub: account_id,
    aud: projectAppAudience(project_id, key, scope),
    hid: host_id,
    key,
    epoch,
    scope,
    ...(browser_session_exp_s == null ? {} : { bse: browser_session_exp_s }),
    iat,
    exp: iat + PROJECT_APP_CAPABILITY_TTL_SECONDS,
    jti: randomUUID(),
    v: APP_TOKEN_VERSION,
  };
  const signingInput = `${base64UrlEncode(
    JSON.stringify({ typ: TOKEN_TYPE, alg: TOKEN_ALG }),
  )}.${base64UrlEncode(JSON.stringify(claims))}`;
  const sig = cryptoSign(
    null,
    Buffer.from(signingInput),
    createPrivateKey(`${private_key ?? ""}`.trim()),
  );
  return {
    token: `${signingInput}.${base64UrlEncode(sig)}`,
    expires_at: claims.exp * 1000,
    claims,
  };
}

// Verifies an app capability for exactly this app origin on exactly this
// host.  The caller still checks single use (jti), the account's access, the
// project's current epoch and the account's cutoffs.
export function verifyProjectAppCapability({
  token,
  project_id,
  key,
  host_id,
  public_key,
  scope = "app",
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: {
  token: string;
  project_id: string;
  key: string;
  host_id: string;
  public_key: string;
  scope?: ProjectAppScope;
  issuer?: string;
  now_ms?: number;
}): ProjectAppCapabilityClaims {
  if (!isValidUUID(project_id) || !isValidUUID(host_id) || !isProjectAppKey(key)) {
    throw new Error("invalid app capability target");
  }
  const parts = `${token ?? ""}`.split(".");
  if (parts.length !== 3) throw new Error("invalid capability format");
  const [encHeader, encClaims, encSig] = parts;
  let header: any;
  let claims: any;
  try {
    header = JSON.parse(base64UrlDecode(encHeader).toString("utf8"));
    claims = JSON.parse(base64UrlDecode(encClaims).toString("utf8"));
  } catch {
    throw new Error("invalid capability format");
  }
  if (header?.typ !== TOKEN_TYPE || header?.alg !== TOKEN_ALG) {
    throw new Error("invalid capability header");
  }
  const ok = cryptoVerify(
    null,
    Buffer.from(`${encHeader}.${encClaims}`),
    createPublicKey(`${public_key ?? ""}`.trim()),
    base64UrlDecode(encSig),
  );
  if (!ok) throw new Error("invalid capability signature");
  const keys =
    claims != null && typeof claims === "object"
      ? Object.keys(claims).sort().join(",")
      : "";
  if (
    (keys !== CLAIM_KEYS_REQUIRED && keys !== CLAIM_KEYS_RESTRICTED) ||
    claims.v !== APP_TOKEN_VERSION ||
    claims.iss !== issuer ||
    claims.scope !== scope ||
    !isValidUUID(claims.sub) ||
    !isValidUUID(claims.jti) ||
    !isEpoch(claims.epoch) ||
    !isProjectAppKey(claims.key) ||
    (claims.bse != null && !Number.isSafeInteger(claims.bse))
  ) {
    throw new Error("invalid capability claims");
  }
  if (
    claims.aud !== projectAppAudience(project_id, key, scope) ||
    claims.key !== key ||
    claims.hid !== host_id
  ) {
    throw new Error("capability is for a different app or host");
  }
  const nowSec = Math.floor(now_ms / 1000);
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > nowSec + CLOCK_TOLERANCE_SECONDS ||
    claims.exp <= nowSec ||
    claims.exp > claims.iat + PROJECT_APP_CAPABILITY_TTL_SECONDS ||
    (claims.bse != null && claims.bse <= nowSec)
  ) {
    throw new Error("capability expired or not yet valid");
  }
  return claims as ProjectAppCapabilityClaims;
}
