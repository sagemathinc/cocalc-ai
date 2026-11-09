/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Fake values only; no network.

import {
  credentialOverridesPresent,
  GoogleIdentityError,
  introspectAccessToken,
  isGoogleUniqueId,
  parseSignerRecord,
  parseTokenInfo,
  signerAccessToken,
  TOKENINFO_URL,
  type TextFetch,
} from "./google-identity";

const SIGNER = "fake-broker@example-project-1.iam.gserviceaccount.com";
const SIGNER_ID = "109876543210987654321"; // 21 digits: beyond safe integers
const OTHER_ID = "109876543210987654322";
const TOKEN = "ya29.fake-metadata-token";
const RECORD = { email: SIGNER, uniqueId: SIGNER_ID };

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl: TextFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route == null) throw Error("no route");
    return {
      status: route.status ?? 200,
      text: async () =>
        typeof route.body === "string"
          ? route.body
          : JSON.stringify(route.body),
    };
  };
  return { fetchImpl, calls };
}

const META =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";

function signerRoutes(claims: Record<string, unknown> = {}, email = SIGNER) {
  return {
    [`${META}email`]: { body: email },
    [`${META}token`]: {
      body: { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" },
    },
    [TOKENINFO_URL]: {
      body: {
        azp: SIGNER_ID,
        aud: SIGNER_ID,
        scope: "x",
        expires_in: "3599",
        ...claims,
      },
    },
  };
}

describe("unique ids", () => {
  it("accepts canonical decimal strings, including beyond safe integers", () => {
    expect(isGoogleUniqueId(SIGNER_ID)).toBe(true);
    expect(isGoogleUniqueId("123456")).toBe(true);
    expect(isGoogleUniqueId("1".repeat(32))).toBe(true);
  });

  it.each([
    ["a leading zero", "0123456789"],
    ["non-digits", "12345a6789"],
    ["a number type", 109876543210987 as unknown],
    ["an unsafe-integer-shaped number", 1.0987654321098765e20 as unknown],
    ["empty", ""],
    ["too short", "12345"],
    ["33 digits", "1".repeat(33)],
    ["whitespace", " 123456789"],
    ["exponent form", "1e21"],
  ])("refuses %s", (_name, value) => {
    expect(isGoogleUniqueId(value)).toBe(false);
  });

  it("parses the signer record strictly", () => {
    expect(parseSignerRecord(RECORD)).toEqual(RECORD);
    expect(
      parseSignerRecord({ ...RECORD, uniqueId: Number(SIGNER_ID) }),
    ).toBeUndefined();
    expect(
      parseSignerRecord({ ...RECORD, email: "someone@gmail.com" }),
    ).toBeUndefined();
  });
});

describe("parseTokenInfo", () => {
  const good = { azp: SIGNER_ID, scope: "s", expires_in: "100" };

  it("returns claims, ids as strings", () => {
    expect(parseTokenInfo({ ...good, aud: SIGNER_ID, email: SIGNER })).toEqual({
      azp: SIGNER_ID,
      aud: SIGNER_ID,
      email: SIGNER,
      scope: "s",
      expiresInS: 100,
    });
  });

  it.each([
    ["a numeric azp", { ...good, azp: 123456789 }],
    ["a missing azp", { scope: "s", expires_in: "1" }],
    ["a malformed aud", { ...good, aud: "0123" }],
    ["an unknown key", { ...good, extra: 1 }],
    ["a numeric expires_in", { ...good, expires_in: 100 }],
    ["a negative expires_in", { ...good, expires_in: "-1" }],
    ["a bad email", { ...good, email: "x@example.com" }],
    ["an array", []],
  ])("refuses %s", (_name, value) => {
    expect(parseTokenInfo(value)).toBeUndefined();
  });
});

describe("introspectAccessToken", () => {
  it("POSTs the token in the form body, never the URL", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [TOKENINFO_URL]: {
        body: { azp: SIGNER_ID, scope: "s", expires_in: "5" },
      },
    });
    await introspectAccessToken(fetchImpl, TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKENINFO_URL);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.body).toBe(
      `access_token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("fails with a fixed code on an error status or a malformed body", async () => {
    for (const route of [
      { status: 400, body: { error: "invalid_token" } },
      { body: "not json" },
      { body: { azp: 5 } },
    ]) {
      const { fetchImpl } = fakeFetch({ [TOKENINFO_URL]: route });
      const err = await introspectAccessToken(fetchImpl, TOKEN).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleIdentityError);
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe("signerAccessToken", () => {
  it("returns the metadata token for exactly the recorded signer", async () => {
    const { fetchImpl, calls } = fakeFetch(signerRoutes());
    await expect(
      signerAccessToken({ fetchImpl, record: RECORD, env: {} }),
    ).resolves.toEqual({ accessToken: TOKEN, expiresInS: 3599 });
    const meta = calls.filter((c) => c.url.startsWith(META));
    expect(
      meta.every((c) => c.init.headers["Metadata-Flavor"] === "Google"),
    ).toBe(true);
    expect(calls.every((c) => c.init.redirect === "error")).toBe(true);
  });

  it.each([
    [
      "another metadata email",
      signerRoutes({}, "other-sa1@example-project-1.iam.gserviceaccount.com"),
    ],
    ["another azp", signerRoutes({ azp: OTHER_ID })],
    ["another aud", signerRoutes({ aud: OTHER_ID })],
    [
      "another tokeninfo email",
      signerRoutes({
        email: "other-sa1@example-project-1.iam.gserviceaccount.com",
      }),
    ],
  ])("refuses %s as identity_mismatch", async (_name, routes) => {
    const { fetchImpl } = fakeFetch(routes);
    await expect(
      signerAccessToken({ fetchImpl, record: RECORD, env: {} }),
    ).rejects.toThrow("identity_mismatch");
  });

  it("fails closed when tokeninfo has no azp (it never falls back to email)", async () => {
    const routes = signerRoutes();
    routes[TOKENINFO_URL] = {
      body: { email: SIGNER, scope: "x", expires_in: "1" },
    };
    const { fetchImpl } = fakeFetch(routes);
    await expect(
      signerAccessToken({ fetchImpl, record: RECORD, env: {} }),
    ).rejects.toThrow(GoogleIdentityError);
  });

  it("refuses to run with a credential override in the environment, before any call", async () => {
    const { fetchImpl, calls } = fakeFetch(signerRoutes());
    for (const name of [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
      "GCE_METADATA_HOST",
    ]) {
      await expect(
        signerAccessToken({ fetchImpl, record: RECORD, env: { [name]: "/x" } }),
      ).rejects.toThrow("credential_override_present");
    }
    expect(calls).toHaveLength(0);
    // A harmless setting is fine.
    expect(credentialOverridesPresent({ CLOUDSDK_CORE_PROJECT: "p" })).toEqual(
      [],
    );
  });

  it("maps an unreachable metadata server to metadata_unavailable", async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(
      signerAccessToken({ fetchImpl, record: RECORD, env: {} }),
    ).rejects.toThrow("metadata_unavailable");
  });
});
