/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import axios from "axios";
import { createSign, generateKeyPairSync } from "crypto";

import {
  googleOidcAuthorizationUrl,
  googleProfileFromClaims,
  verifyGoogleIdToken,
} from "./google-oidc";

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

function encodedJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signedToken({
  claims,
  kid = "test-key",
}: {
  claims: object;
  kid?: string;
}): { idToken: string; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const header = encodedJson({ alg: "RS256", kid, typ: "JWT" });
  const payload = encodedJson(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    idToken: `${header}.${payload}.${signature}`,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" },
  };
}

describe("googleOidcAuthorizationUrl", () => {
  it("builds a Google OIDC authorization URL", () => {
    const url = new URL(
      googleOidcAuthorizationUrl({
        clientID: "client-id",
        redirectURI: "https://example.com/auth/google/return",
        state: "state",
        nonce: "nonce",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/auth/google/return",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("nonce")).toBe("nonce");
  });
});

describe("verifyGoogleIdToken", () => {
  it("verifies signature and required Google claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { idToken, jwk } = signedToken({
      claims: {
        iss: "https://accounts.google.com",
        aud: "client-id",
        exp: now + 600,
        nonce: "nonce",
        sub: "google-subject",
        email: "User@Example.com",
        email_verified: true,
      },
    });
    (axios.get as jest.Mock).mockResolvedValueOnce({
      data: { keys: [jwk] },
      headers: { "cache-control": "max-age=0" },
    });

    const claims = await verifyGoogleIdToken({
      idToken,
      clientID: "client-id",
      nonce: "nonce",
    });

    expect(claims.sub).toBe("google-subject");
    expect(claims.email).toBe("User@Example.com");
  });

  it("rejects an unverified email claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { idToken, jwk } = signedToken({
      claims: {
        iss: "https://accounts.google.com",
        aud: "client-id",
        exp: now + 600,
        nonce: "nonce",
        sub: "google-subject",
        email: "user@example.com",
        email_verified: false,
      },
      kid: "unverified-email-key",
    });
    (axios.get as jest.Mock).mockResolvedValueOnce({
      data: { keys: [jwk] },
      headers: { "cache-control": "max-age=0" },
    });

    await expect(
      verifyGoogleIdToken({
        idToken,
        clientID: "client-id",
        nonce: "nonce",
      }),
    ).rejects.toThrow("Google did not verify the email address.");
  });
});

describe("googleProfileFromClaims", () => {
  it("creates a PassportLogin-compatible profile", () => {
    const profile = googleProfileFromClaims({
      iss: "https://accounts.google.com",
      aud: "client-id",
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: "nonce",
      sub: "google-subject",
      email: "user@example.com",
      email_verified: true,
      given_name: "Ada",
      family_name: "Lovelace",
    });

    expect(profile.id).toBe("google-subject");
    expect(profile.name).toEqual({
      givenName: "Ada",
      familyName: "Lovelace",
    });
    expect(profile.emails).toEqual([
      { value: "user@example.com", verified: true },
    ]);
    expect(profile.email_verified).toBe(true);
  });
});
