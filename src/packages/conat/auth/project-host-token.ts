import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from "crypto";
import { isValidUUID } from "@cocalc/util/misc";
import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";
import { apiKeyViewerFsSubject } from "./project-host-api-key-subject";

/*
Project-host auth token protocol (overview):

- Token format: compact JWT-style token with 3 base64url parts
  (header.payload.signature).
- Signature algorithm: Ed25519 (`alg=EdDSA`).
- Issuer/trust model:
  - Central hub signs tokens with an Ed25519 private key.
  - Project-host verifies signatures with the corresponding public key.
  - Project-host does not possess signing capability.
  - Browser presents token during socket.io websocket auth.
- Claims enforced:
  - act = account|hub
  - sub = account_id (browser actor) or hub principal id (hub actor)
  - aud = project-host:<host_id> (where token is valid)
  - iat/exp (short TTL)
  - jti (unique id), v (protocol version)

Keying/rotation notes:
- Current code verifies one active public key.
- Planned key rotation can be added by introducing `kid` and a verifier key ring
  that accepts current+previous public keys during rollout.
*/

const TOKEN_TYPE = "JWT";
const TOKEN_ALG = "EdDSA";
const TOKEN_VERSION = "phat-v1";
const RESTRICTED_BROWSER_SESSION_TOKEN_VERSION = "phat-v2";
const API_KEY_TOKEN_VERSION = "phat-v3";
const API_KEY_HTTP_TOKEN_VERSION = "phat-http-v1";
const API_KEY_TOKEN_TTL_SECONDS = 25;
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const MAX_BROWSER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 30;
export type ProjectHostAuthActor = "account" | "hub";
const DEFAULT_HUB_SUBJECT = "hub";

export interface ProjectHostAuthClaims {
  iss: string;
  sub: string; // account_id or hub principal
  aud: string; // project-host:<host_id>
  iat: number;
  exp: number;
  jti: string;
  v: string;
  act?: ProjectHostAuthActor;
  // Signed credential provenance. Absent on pre-cutover tokens, which must
  // not authorize human-only automation settings changes.
  auth_actor?: "account" | "agent";
  // Required for agent credentials; the host audience alone is not a project boundary.
  project_id?: string;
  sid?: string;
  browser_session_exp_s?: number;
  api_key?: ProjectHostApiKeyBinding;
  http_proxy_port?: number;
}

export interface ProjectHostApiKeyBinding {
  account_id: string;
  key_id: string;
  scope_revision: number;
  project_id: string;
  placement_revision: number;
  capabilities: ApiKeyCapability[];
  viewer_policy_hash?: string;
  subjects: string[];
  reply_prefix: string;
}

export interface IssueProjectHostApiKeyTokenOptions {
  host_id: string;
  account_id: string;
  project_id: string;
  key_id: string;
  scope_revision: number;
  placement_revision: number;
  capabilities: ApiKeyCapability[];
  viewer_policy_hash?: string;
  parent_exp_s?: number;
  private_key: string;
  issuer?: string;
  now_ms?: number;
}

const API_KEY_PROJECT_CAPABILITIES = new Set<ApiKeyCapability>([
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
]);

// A runtime key may use reviewed project data-plane services, not every
// present or future subject beneath project.<id>.
const API_KEY_RUNTIME_SERVICES = [
  "api",
  "archive-info",
  "document-build-events",
  "exec-job-events",
  "exec-job-snapshot",
  "jupyter-live-run",
  "project-info",
  "project-status",
  "pubsub-cursors",
  "run",
  "storage-info",
  "touch",
  "usage-info",
] as const;

function apiKeySubjects({
  account_id,
  project_id,
  key_id,
  scope_revision,
  capabilities,
  viewer_policy_hash,
}: Pick<
  ProjectHostApiKeyBinding,
  | "account_id"
  | "project_id"
  | "key_id"
  | "scope_revision"
  | "capabilities"
  | "viewer_policy_hash"
>): string[] {
  const grants = new Set(capabilities);
  const subjects: string[] = [];
  if (grants.has("project:exec")) {
    subjects.push(
      ...API_KEY_RUNTIME_SERVICES.map(
        (service) => `project.${project_id}.${service}.`,
      ),
      `project.${project_id}.run`,
      `terminal.project-${project_id}.`,
      `jupyter.project-${project_id}.`,
      `persist.project-${project_id}.`,
    );
  }
  if (grants.has("file:write") || grants.has("project:exec")) {
    subjects.push(`fs.project-${project_id}`);
  } else if (grants.has("file:read")) {
    if (viewer_policy_hash) {
      subjects.push(
        apiKeyViewerFsSubject({
          project_id,
          account_id,
          key_id,
          scope_revision,
          viewer_policy_hash,
        }),
      );
    }
  }
  return subjects.sort();
}

function validateApiKeyBinding(binding: ProjectHostApiKeyBinding): void {
  if (
    !binding ||
    !isValidUUID(binding.account_id) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(binding.key_id) ||
    !isValidUUID(binding.project_id) ||
    !Number.isSafeInteger(binding.scope_revision) ||
    binding.scope_revision < 1 ||
    !Number.isSafeInteger(binding.placement_revision) ||
    binding.placement_revision < 0 ||
    !Array.isArray(binding.capabilities) ||
    binding.capabilities.length === 0 ||
    binding.capabilities.some((c) => !API_KEY_PROJECT_CAPABILITIES.has(c)) ||
    new Set(binding.capabilities).size !== binding.capabilities.length
  ) {
    throw new Error("invalid API key project-host binding");
  }
  const needsViewerPolicy =
    binding.capabilities.includes("file:read") &&
    !binding.capabilities.includes("file:write") &&
    !binding.capabilities.includes("project:exec");
  if (
    needsViewerPolicy !== (binding.viewer_policy_hash != null) ||
    (binding.viewer_policy_hash != null &&
      !/^[a-f0-9]{64}$/.test(binding.viewer_policy_hash))
  ) {
    throw new Error("invalid API key viewer policy binding");
  }
  const expected = apiKeySubjects(binding);
  if (
    !Array.isArray(binding.subjects) ||
    JSON.stringify(binding.subjects) !== JSON.stringify(expected)
  ) {
    throw new Error("invalid API key service audience");
  }
}

export function issueProjectHostApiKeyAuthToken(
  options: IssueProjectHostApiKeyTokenOptions,
) {
  return issueScopedProjectHostToken(options);
}

export function issueProjectHostApiKeyHttpToken(
  options: IssueProjectHostApiKeyTokenOptions & { port: number },
) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw Error("invalid HTTP proxy port");
  }
  if (!options.capabilities.includes("project:exec")) {
    throw Error("HTTP app access requires project:exec");
  }
  return issueScopedProjectHostToken(options, options.port);
}

function issueScopedProjectHostToken(
  {
    host_id,
    account_id,
    project_id,
    key_id,
    scope_revision,
    placement_revision,
    capabilities,
    viewer_policy_hash,
    parent_exp_s,
    private_key,
    issuer = "cocalc-hub",
    now_ms = Date.now(),
  }: IssueProjectHostApiKeyTokenOptions,
  httpProxyPort?: number,
): {
  token: string;
  expires_at: number;
  claims: ProjectHostAuthClaims;
} {
  ensureValidHostId(host_id);
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  const iat = Math.floor(now_ms / 1000);
  const exp = Math.min(
    iat + API_KEY_TOKEN_TTL_SECONDS,
    parent_exp_s ?? Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(exp) || exp <= iat) {
    throw new Error("API key parent has expired");
  }
  const jti = randomUUID();
  const binding: ProjectHostApiKeyBinding = {
    account_id,
    key_id,
    scope_revision,
    project_id,
    placement_revision,
    capabilities: [...capabilities].sort(),
    ...(viewer_policy_hash ? { viewer_policy_hash } : {}),
    subjects: apiKeySubjects({
      account_id,
      project_id,
      key_id,
      scope_revision,
      capabilities,
      viewer_policy_hash,
    }),
    reply_prefix: `_INBOX.api-key-${jti}`,
  };
  validateApiKeyBinding(binding);
  const claims: ProjectHostAuthClaims = {
    iss: issuer,
    sub: account_id,
    aud:
      httpProxyPort == null
        ? `project-host:${host_id}`
        : `project-host-http:${host_id}`,
    iat,
    exp,
    jti,
    v:
      httpProxyPort == null
        ? API_KEY_TOKEN_VERSION
        : API_KEY_HTTP_TOKEN_VERSION,
    act: "account",
    api_key: binding,
    ...(httpProxyPort == null ? {} : { http_proxy_port: httpProxyPort }),
  };
  const token = signClaims(claims, private_key);
  return { token, expires_at: exp * 1000, claims };
}

function signClaims(
  claims: ProjectHostAuthClaims,
  private_key: string,
): string {
  const key = getPrivateKey(private_key);
  const encHeader = base64UrlEncode(
    JSON.stringify({ typ: TOKEN_TYPE, alg: TOKEN_ALG }),
  );
  const encClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encClaims}`;
  const sig = cryptoSign(null, Buffer.from(signingInput), key);
  return `${encHeader}.${encClaims}.${base64UrlEncode(sig)}`;
}

export interface IssueProjectHostTokenOptions {
  host_id: string;
  private_key: string;
  ttl_seconds?: number;
  issuer?: string;
  now_ms?: number;
  actor?: ProjectHostAuthActor;
  auth_actor?: "account" | "agent";
  project_id?: string;
  account_id?: string;
  hub_id?: string;
  session_id?: string;
  browser_session_exp_s?: number;
}

export interface VerifyProjectHostTokenOptions {
  token: string;
  host_id: string;
  public_key: string;
  issuer?: string;
  now_ms?: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64");
}

function getPrivateKey(private_key: string) {
  const value = `${private_key ?? ""}`.trim();
  if (!value) {
    throw new Error("project-host auth signing private key is not configured");
  }
  return createPrivateKey(value);
}

function getPublicKey(public_key: string) {
  const value = `${public_key ?? ""}`.trim();
  if (!value) {
    throw new Error(
      "project-host auth verification public key is not configured",
    );
  }
  return createPublicKey(value);
}

function normalizeTtlSeconds(ttl_seconds?: number): number {
  const ttl = Number(ttl_seconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)));
}

function ensureValidHostId(host_id: string) {
  if (!isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
}

function getActorAndSubject({
  actor,
  account_id,
  hub_id,
}: {
  actor?: ProjectHostAuthActor;
  account_id?: string;
  hub_id?: string;
}): { actor: ProjectHostAuthActor; subject: string } {
  const normalizedActor = actor ?? "account";
  if (normalizedActor === "account") {
    if (!isValidUUID(account_id)) {
      throw new Error("invalid account_id");
    }
    return { actor: normalizedActor, subject: account_id as string };
  }
  const subject = `${hub_id ?? DEFAULT_HUB_SUBJECT}`.trim();
  if (!subject) {
    throw new Error("invalid hub_id");
  }
  return { actor: normalizedActor, subject };
}

export function issueProjectHostAuthToken({
  host_id,
  private_key,
  ttl_seconds,
  issuer = "cocalc-hub",
  now_ms = Date.now(),
  actor,
  auth_actor,
  project_id,
  account_id,
  hub_id,
  session_id,
  browser_session_exp_s,
}: IssueProjectHostTokenOptions): {
  token: string;
  expires_at: number;
  claims: ProjectHostAuthClaims;
} {
  ensureValidHostId(host_id);
  const identity = getActorAndSubject({ actor, account_id, hub_id });
  if (session_id != null && !isValidUUID(session_id)) {
    throw new Error("invalid session_id");
  }
  if (auth_actor === "agent" && !isValidUUID(project_id)) {
    throw new Error("agent token requires project_id");
  }
  const iat = Math.floor(now_ms / 1000);
  const exp = iat + normalizeTtlSeconds(ttl_seconds);
  const browserSessionExp =
    browser_session_exp_s == null
      ? undefined
      : Math.floor(Number(browser_session_exp_s));
  if (
    browserSessionExp != null &&
    (!Number.isSafeInteger(browserSessionExp) ||
      browserSessionExp <= iat ||
      browserSessionExp > iat + MAX_BROWSER_SESSION_TTL_SECONDS)
  ) {
    throw new Error("invalid browser session expiration");
  }
  const claims: ProjectHostAuthClaims = {
    iss: issuer,
    sub: identity.subject,
    aud: `project-host:${host_id}`,
    iat,
    exp,
    jti: randomUUID(),
    v:
      browserSessionExp == null
        ? TOKEN_VERSION
        : RESTRICTED_BROWSER_SESSION_TOKEN_VERSION,
    act: identity.actor,
    ...(auth_actor ? { auth_actor } : {}),
    ...(auth_actor === "agent" ? { project_id } : {}),
    ...(session_id ? { sid: session_id } : {}),
    ...(browserSessionExp == null
      ? {}
      : { browser_session_exp_s: browserSessionExp }),
  };

  return {
    token: signClaims(claims, private_key),
    expires_at: exp * 1000,
    claims,
  };
}

function parseClaims(token: string): {
  header: Record<string, any>;
  claims: ProjectHostAuthClaims;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid token format");
  }
  const [encHeader, encClaims, encSig] = parts;
  const signingInput = `${encHeader}.${encClaims}`;
  const header = JSON.parse(base64UrlDecode(encHeader).toString("utf8"));
  const claims = JSON.parse(
    base64UrlDecode(encClaims).toString("utf8"),
  ) as ProjectHostAuthClaims;
  const signature = base64UrlDecode(encSig);
  return { header, claims, signingInput, signature };
}

export function verifyProjectHostAuthToken(
  options: VerifyProjectHostTokenOptions,
): ProjectHostAuthClaims {
  return verifyHostToken(options, false);
}

export function verifyProjectHostApiKeyHttpToken(
  options: VerifyProjectHostTokenOptions & { project_id: string; port: number },
): ProjectHostAuthClaims {
  const claims = verifyHostToken(options, true);
  if (
    claims.api_key?.project_id !== options.project_id ||
    claims.http_proxy_port !== options.port
  ) {
    throw Error("HTTP proxy target mismatch");
  }
  return claims;
}

function verifyHostToken(
  {
    token,
    host_id,
    public_key,
    issuer = "cocalc-hub",
    now_ms = Date.now(),
  }: VerifyProjectHostTokenOptions,
  http: boolean,
): ProjectHostAuthClaims {
  ensureValidHostId(host_id);
  const key = getPublicKey(public_key);
  const { header, claims, signingInput, signature } = parseClaims(token);

  if (header?.typ !== TOKEN_TYPE || header?.alg !== TOKEN_ALG) {
    throw new Error("invalid token header");
  }

  const ok = cryptoVerify(null, Buffer.from(signingInput), key, signature);
  if (!ok) {
    throw new Error("invalid token signature");
  }

  if (
    http
      ? claims?.v !== API_KEY_HTTP_TOKEN_VERSION
      : claims?.v !== TOKEN_VERSION &&
        claims?.v !== RESTRICTED_BROWSER_SESSION_TOKEN_VERSION &&
        claims?.v !== API_KEY_TOKEN_VERSION
  ) {
    throw new Error("invalid token version");
  }
  if (claims?.iss !== issuer) {
    throw new Error("invalid token issuer");
  }
  if (!isValidUUID(claims?.jti)) {
    throw new Error("invalid token jti");
  }
  const nowSec = Math.floor(now_ms / 1000);
  if (
    typeof claims.iat !== "number" ||
    claims.iat > nowSec + CLOCK_TOLERANCE_SECONDS
  ) {
    throw new Error("token not yet valid");
  }
  if (
    typeof claims.exp !== "number" ||
    (claims.v === API_KEY_TOKEN_VERSION || http
      ? claims.exp <= nowSec ||
        claims.exp > claims.iat + API_KEY_TOKEN_TTL_SECONDS
      : claims.exp < nowSec - CLOCK_TOLERANCE_SECONDS)
  ) {
    throw new Error("token expired");
  }

  const expectedAud = `${http ? "project-host-http" : "project-host"}:${host_id}`;
  if (claims.aud !== expectedAud) {
    throw new Error("invalid token audience");
  }

  const actor = claims?.act ?? "account";
  if (
    claims.auth_actor != null &&
    claims.auth_actor !== "account" &&
    claims.auth_actor !== "agent"
  ) {
    throw new Error("invalid token credential actor");
  }
  if (claims.auth_actor === "agent" && !isValidUUID(claims.project_id)) {
    throw new Error("agent token missing project binding");
  }
  if (actor !== "account" && actor !== "hub") {
    throw new Error("invalid token actor");
  }
  if (actor === "account") {
    if (!isValidUUID(claims?.sub)) {
      throw new Error("invalid token subject");
    }
  } else if (`${claims?.sub ?? ""}`.trim().length === 0) {
    throw new Error("invalid token subject");
  }
  if (claims.sid != null && !isValidUUID(claims.sid)) {
    throw new Error("invalid token session");
  }
  if (claims.v === RESTRICTED_BROWSER_SESSION_TOKEN_VERSION) {
    if (
      !Number.isSafeInteger(claims.browser_session_exp_s) ||
      claims.browser_session_exp_s! <= claims.iat ||
      claims.browser_session_exp_s! >
        claims.iat + MAX_BROWSER_SESSION_TTL_SECONDS
    ) {
      throw new Error("invalid browser session expiration");
    }
  } else if (claims.browser_session_exp_s != null) {
    throw new Error("invalid browser session token version");
  }
  if (claims.v === API_KEY_TOKEN_VERSION || http) {
    if (
      actor !== "account" ||
      claims.auth_actor != null ||
      claims.sid != null ||
      claims.api_key?.reply_prefix !== `_INBOX.api-key-${claims.jti}` ||
      claims.api_key?.account_id !== claims.sub
    ) {
      throw new Error("invalid API key project-host identity");
    }
    validateApiKeyBinding(claims.api_key);
  } else if (claims.api_key != null) {
    throw new Error("invalid API key token version");
  }

  if (http) {
    if (
      !Number.isInteger(claims.http_proxy_port) ||
      claims.http_proxy_port! < 1 ||
      claims.http_proxy_port! > 65535 ||
      !claims.api_key?.capabilities.includes("project:exec")
    ) {
      throw Error("invalid HTTP proxy authority");
    }
  } else if (claims.http_proxy_port != null) {
    throw Error("invalid HTTP proxy token version");
  }

  return claims;
}
