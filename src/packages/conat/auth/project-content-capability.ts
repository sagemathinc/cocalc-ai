/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project content capability (trust-free step 6).

Project files are served on a per-project content origin,
  https://<project>.h-<host>.<content domain>/_c/<capability>/files/<path>
so relative URLs in project HTML resolve under the capability and work with
no cookies.  The capability is what authorizes the request:

- Compact JWT-style token, Ed25519 signed by the hub, verified by the project
  host with the same key pair as project-host auth tokens.
- Its own version and audience, and exactly the claims below, so it is never
  accepted as a project-host auth token and vice versa.
- aud = project-content:<project_id>, hid = the host serving that project.
  The host additionally binds both to the request's hostname.
- sub = the account it reads as; the host re-checks access on every request.
- epoch = the project's content epoch when issued; bumping the epoch revokes
  every outstanding capability of the project.
- scope = "read", limited to dir: the absolute directory whose files (and
  subdirectories) it may read.  HTML in a project isn't always written by
  its members (course collect and peer grading copy students' work into
  other projects), so a page's link must not reach the rest of the project.
*/

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from "crypto";
import { isValidUUID } from "@cocalc/util/misc";

const TOKEN_TYPE = "JWT";
const TOKEN_ALG = "EdDSA";
const CONTENT_TOKEN_VERSION = "pcc-v2";
const CLAIM_KEYS = "aud,dir,epoch,exp,hid,iat,iss,jti,scope,sub,v";
const MAX_DIR_LENGTH = 4096;
const CLOCK_TOLERANCE_SECONDS = 30;

export const PROJECT_CONTENT_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;
export const PROJECT_CONTENT_CAPABILITY_MIN_TTL_SECONDS = 60;

export interface ProjectContentCapabilityClaims {
  iss: string;
  sub: string; // account_id
  aud: string; // project-content:<project_id>
  hid: string; // host_id
  epoch: number;
  scope: "read";
  dir: string; // absolute, normalized; "/" is the whole project
  iat: number;
  exp: number;
  jti: string;
  v: string;
}

// The canonical form of a capability's directory, or an error.
export function normalizeContentDir(dir: unknown): string {
  const raw = `${dir ?? ""}`;
  if (!raw.startsWith("/") || raw.length > MAX_DIR_LENGTH || raw.includes("\0")) {
    throw new Error("invalid content directory");
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("invalid content directory");
  }
  return `/${segments.join("/")}`;
}

// Whether an absolute, normalized path is dir or inside it.
export function contentPathWithinDir(path: string, dir: string): boolean {
  if (dir === "/") return path.startsWith("/");
  return path === dir || path.startsWith(`${dir}/`);
}

export function projectContentAudience(project_id: string): string {
  return `project-content:${project_id}`;
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
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64");
}

function isCanonicalDir(value: unknown): value is string {
  try {
    return typeof value === "string" && normalizeContentDir(value) === value;
  } catch {
    return false;
  }
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function issueProjectContentCapability({
  project_id,
  host_id,
  account_id,
  epoch,
  dir,
  private_key,
  ttl_seconds = PROJECT_CONTENT_CAPABILITY_TTL_SECONDS,
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: {
  project_id: string;
  host_id: string;
  account_id: string;
  epoch: number;
  dir: string;
  private_key: string;
  ttl_seconds?: number;
  issuer?: string;
  now_ms?: number;
}): { token: string; expires_at: number; claims: ProjectContentCapabilityClaims } {
  if (
    !isValidUUID(project_id) ||
    !isValidUUID(host_id) ||
    !isValidUUID(account_id)
  ) {
    throw new Error("invalid content capability identity");
  }
  if (!isEpoch(epoch)) {
    throw new Error("invalid content epoch");
  }
  const scopeDir = normalizeContentDir(dir);
  const ttl = Math.floor(ttl_seconds);
  if (
    !(
      ttl >= PROJECT_CONTENT_CAPABILITY_MIN_TTL_SECONDS &&
      ttl <= PROJECT_CONTENT_CAPABILITY_TTL_SECONDS
    )
  ) {
    throw new Error("invalid content capability lifetime");
  }
  const iat = Math.floor(now_ms / 1000);
  const claims: ProjectContentCapabilityClaims = {
    iss: issuer,
    sub: account_id,
    aud: projectContentAudience(project_id),
    hid: host_id,
    epoch,
    scope: "read",
    dir: scopeDir,
    iat,
    exp: iat + ttl,
    jti: randomUUID(),
    v: CONTENT_TOKEN_VERSION,
  };
  const key = createPrivateKey(`${private_key ?? ""}`.trim());
  const signingInput = `${base64UrlEncode(
    JSON.stringify({ typ: TOKEN_TYPE, alg: TOKEN_ALG }),
  )}.${base64UrlEncode(JSON.stringify(claims))}`;
  const sig = cryptoSign(null, Buffer.from(signingInput), key);
  return {
    token: `${signingInput}.${base64UrlEncode(sig)}`,
    expires_at: claims.exp * 1000,
    claims,
  };
}

// Verifies a capability for exactly this project on exactly this host.
// Throws on any mismatch; the caller still checks the account's access and
// the project's current content epoch.
export function verifyProjectContentCapability({
  token,
  project_id,
  host_id,
  public_key,
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: {
  token: string;
  project_id: string;
  host_id: string;
  public_key: string;
  issuer?: string;
  now_ms?: number;
}): ProjectContentCapabilityClaims {
  if (!isValidUUID(project_id) || !isValidUUID(host_id)) {
    throw new Error("invalid content capability target");
  }
  const parts = `${token ?? ""}`.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid capability format");
  }
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
  const key = createPublicKey(`${public_key ?? ""}`.trim());
  const ok = cryptoVerify(
    null,
    Buffer.from(`${encHeader}.${encClaims}`),
    key,
    base64UrlDecode(encSig),
  );
  if (!ok) {
    throw new Error("invalid capability signature");
  }
  if (
    claims == null ||
    typeof claims !== "object" ||
    Object.keys(claims).sort().join(",") !== CLAIM_KEYS ||
    claims.v !== CONTENT_TOKEN_VERSION ||
    claims.iss !== issuer ||
    claims.scope !== "read" ||
    !isValidUUID(claims.sub) ||
    !isValidUUID(claims.jti) ||
    !isEpoch(claims.epoch) ||
    !isCanonicalDir(claims.dir)
  ) {
    throw new Error("invalid capability claims");
  }
  if (
    claims.aud !== projectContentAudience(project_id) ||
    claims.hid !== host_id
  ) {
    throw new Error("capability is for a different project or host");
  }
  const nowSec = Math.floor(now_ms / 1000);
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > nowSec + CLOCK_TOLERANCE_SECONDS ||
    claims.exp <= nowSec ||
    claims.exp > claims.iat + PROJECT_CONTENT_CAPABILITY_TTL_SECONDS
  ) {
    throw new Error("capability expired or not yet valid");
  }
  return claims as ProjectContentCapabilityClaims;
}
