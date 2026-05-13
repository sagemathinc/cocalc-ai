/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import axios from "axios";
import { createPublicKey, createVerify } from "crypto";
import type { Profile } from "passport";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);
const CLOCK_SKEW_SECONDS = 300;

interface GoogleJwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

interface GoogleJwks {
  keys: GoogleJwk[];
}

interface CachedJwks {
  expires: number;
  jwks: GoogleJwks;
}

export interface GoogleOidcTokenResponse {
  id_token: string;
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GoogleIdTokenClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  sub: string;
  email: string;
  email_verified: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

let cachedJwks: CachedJwks | undefined;

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function decodeJsonSegment<T>(value: string): T {
  return JSON.parse(base64UrlDecode(value).toString("utf8"));
}

function parseCacheMaxAge(cacheControl: string | undefined): number {
  const match = `${cacheControl ?? ""}`.match(/(?:^|,\s*)max-age=(\d+)/i);
  return match == null ? 3600 : Number(match[1]);
}

async function getGoogleJwks(): Promise<GoogleJwks> {
  if (cachedJwks != null && cachedJwks.expires > Date.now()) {
    return cachedJwks.jwks;
  }
  const response = await axios.get<GoogleJwks>(GOOGLE_JWKS_URL, {
    responseType: "json",
  });
  const maxAgeSeconds = parseCacheMaxAge(response.headers["cache-control"]);
  cachedJwks = {
    expires: Date.now() + maxAgeSeconds * 1000,
    jwks: response.data,
  };
  return response.data;
}

function assertValidClaims({
  claims,
  clientID,
  nonce,
}: {
  claims: GoogleIdTokenClaims;
  clientID: string;
  nonce: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss)) {
    throw new Error("Google ID token has an invalid issuer.");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientID)) {
    throw new Error("Google ID token has an invalid audience.");
  }
  if (audiences.length > 1 && claims.azp !== clientID) {
    throw new Error("Google ID token has an invalid authorized party.");
  }
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new Error("Google ID token is expired.");
  }
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new Error("Google ID token was issued in the future.");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    throw new Error("Google ID token is not valid yet.");
  }
  if (claims.nonce !== nonce) {
    throw new Error("Google ID token nonce did not match.");
  }
  if (!claims.sub) {
    throw new Error("Google ID token is missing a subject.");
  }
  if (!claims.email) {
    throw new Error("Google ID token is missing an email address.");
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new Error("Google did not verify the email address.");
  }
}

export function googleOidcAuthorizationUrl({
  clientID,
  redirectURI,
  state,
  nonce,
}: {
  clientID: string;
  redirectURI: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", clientID);
  url.searchParams.set("redirect_uri", redirectURI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleOidcCode({
  code,
  clientID,
  clientSecret,
  redirectURI,
}: {
  code: string;
  clientID: string;
  clientSecret: string;
  redirectURI: string;
}): Promise<GoogleOidcTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientID,
    client_secret: clientSecret,
    redirect_uri: redirectURI,
    grant_type: "authorization_code",
  });
  const response = await axios.post<GoogleOidcTokenResponse>(
    GOOGLE_TOKEN_URL,
    body.toString(),
    {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      responseType: "json",
    },
  );
  if (!response.data.id_token) {
    throw new Error("Google token response did not include an ID token.");
  }
  return response.data;
}

export async function verifyGoogleIdToken({
  idToken,
  clientID,
  nonce,
}: {
  idToken: string;
  clientID: string;
  nonce: string;
}): Promise<GoogleIdTokenClaims> {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Google ID token is malformed.");
  }
  const header = decodeJsonSegment<{ alg?: string; kid?: string }>(
    encodedHeader,
  );
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Google ID token uses an unsupported signature.");
  }

  let jwks = await getGoogleJwks();
  let jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (jwk == null) {
    cachedJwks = undefined;
    jwks = await getGoogleJwks();
    jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (jwk == null) {
      throw new Error("Google ID token signing key was not found.");
    }
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const valid = verifier.verify(
    createPublicKey({ key: jwk as any, format: "jwk" }),
    base64UrlDecode(encodedSignature),
  );
  if (!valid) {
    throw new Error("Google ID token signature is invalid.");
  }

  const claims = decodeJsonSegment<GoogleIdTokenClaims>(encodedPayload);
  assertValidClaims({ claims, clientID, nonce });
  return claims;
}

export function googleProfileFromClaims(
  claims: GoogleIdTokenClaims,
): Profile & {
  _json: GoogleIdTokenClaims;
  email?: string;
  email_verified?: boolean | string;
} {
  const profile: Profile & {
    _json: GoogleIdTokenClaims;
    email?: string;
    email_verified?: boolean | string;
  } = {
    provider: "google",
    id: claims.sub,
    displayName: claims.name ?? claims.email,
    emails: [
      {
        value: claims.email,
        verified:
          claims.email_verified === true || claims.email_verified === "true",
      } as any,
    ],
    _json: claims,
    email: claims.email,
    email_verified: claims.email_verified,
  };
  if (claims.given_name || claims.family_name) {
    profile.name = {
      givenName: claims.given_name ?? "",
      familyName: claims.family_name ?? "",
    };
  }
  return profile;
}
