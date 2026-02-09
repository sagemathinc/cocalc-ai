import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomUUID,
} from "crypto";
import { isValidUUID } from "@cocalc/util/misc";

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
  - sub = account_id (who the browser is acting as)
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
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const MIN_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 30;

export interface ProjectHostAuthClaims {
  iss: string;
  sub: string; // account_id
  aud: string; // project-host:<host_id>
  iat: number;
  exp: number;
  jti: string;
  v: string;
}

export interface IssueProjectHostTokenOptions {
  account_id: string;
  host_id: string;
  private_key: string;
  ttl_seconds?: number;
  issuer?: string;
  now_ms?: number;
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
    throw new Error("project-host auth verification public key is not configured");
  }
  return createPublicKey(value);
}

function normalizeTtlSeconds(ttl_seconds?: number): number {
  const ttl = Number(ttl_seconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)));
}

function ensureValidInputs({ account_id, host_id }: { account_id: string; host_id: string }) {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  if (!isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
}

export function issueProjectHostAuthToken({
  account_id,
  host_id,
  private_key,
  ttl_seconds,
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: IssueProjectHostTokenOptions): {
  token: string;
  expires_at: number;
  claims: ProjectHostAuthClaims;
} {
  ensureValidInputs({ account_id, host_id });
  const key = getPrivateKey(private_key);
  const iat = Math.floor(now_ms / 1000);
  const exp = iat + normalizeTtlSeconds(ttl_seconds);
  const claims: ProjectHostAuthClaims = {
    iss: issuer,
    sub: account_id,
    aud: `project-host:${host_id}`,
    iat,
    exp,
    jti: randomUUID(),
    v: TOKEN_VERSION,
  };

  const header = {
    typ: TOKEN_TYPE,
    alg: TOKEN_ALG,
  };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encClaims}`;
  const sig = cryptoSign(null, Buffer.from(signingInput), key);
  const encSig = base64UrlEncode(sig);

  return {
    token: `${encHeader}.${encClaims}.${encSig}`,
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

export function verifyProjectHostAuthToken({
  token,
  host_id,
  public_key,
  issuer = "cocalc-hub",
  now_ms = Date.now(),
}: VerifyProjectHostTokenOptions): ProjectHostAuthClaims {
  if (!isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  const key = getPublicKey(public_key);
  const { header, claims, signingInput, signature } = parseClaims(token);

  if (header?.typ !== TOKEN_TYPE || header?.alg !== TOKEN_ALG) {
    throw new Error("invalid token header");
  }

  const ok = cryptoVerify(
    null,
    Buffer.from(signingInput),
    key,
    signature,
  );
  if (!ok) {
    throw new Error("invalid token signature");
  }

  if (claims?.v !== TOKEN_VERSION) {
    throw new Error("invalid token version");
  }
  if (claims?.iss !== issuer) {
    throw new Error("invalid token issuer");
  }
  if (!isValidUUID(claims?.sub)) {
    throw new Error("invalid token subject");
  }
  if (!isValidUUID(claims?.jti)) {
    throw new Error("invalid token jti");
  }

  const nowSec = Math.floor(now_ms / 1000);
  if (typeof claims.iat !== "number" || claims.iat > nowSec + CLOCK_TOLERANCE_SECONDS) {
    throw new Error("token not yet valid");
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSec - CLOCK_TOLERANCE_SECONDS) {
    throw new Error("token expired");
  }

  const expectedAud = `project-host:${host_id}`;
  if (claims.aud !== expectedAud) {
    throw new Error("invalid token audience");
  }

  return claims;
}
