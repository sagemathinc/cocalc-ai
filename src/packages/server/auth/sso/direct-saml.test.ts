/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ValidateInResponseTo } from "@node-saml/passport-saml";

import {
  directSamlCallbackUrl,
  directSamlConfig,
  directSamlMetadataIssuer,
  passportProfileFromSamlProfile,
} from "./direct-saml";

const cacheProvider = {
  saveAsync: jest.fn(),
  getAsync: jest.fn(),
  removeAsync: jest.fn(),
};

describe("directSamlConfig", () => {
  it("uses secure SP-initiated defaults", () => {
    const config = directSamlConfig({
      name: "cornell",
      authUrl: "https://cocalc.example/auth",
      cacheProvider,
      config: {
        type: "saml",
        entryPoint: "https://idp.example/sso",
        idpCert: "CERT",
      },
    });

    expect(config.entryPoint).toBe("https://idp.example/sso");
    expect(config.idpCert).toBe("CERT");
    expect(config.callbackUrl).toBe(
      "https://cocalc.example/auth/cornell/return",
    );
    expect(config.issuer).toBe("https://cocalc.example/auth/cornell/metadata");
    expect(config.audience).toBe(config.issuer);
    expect(config.validateInResponseTo).toBe(ValidateInResponseTo.always);
    expect(config.wantAssertionsSigned).toBe(true);
    expect(config.digestAlgorithm).toBe("sha256");
    expect(config.signatureAlgorithm).toBe("sha256");
  });

  it("rejects SP private key material in provider config", () => {
    expect(() =>
      directSamlConfig({
        name: "cornell",
        authUrl: "https://cocalc.example/auth",
        cacheProvider,
        config: {
          type: "saml",
          entryPoint: "https://idp.example/sso",
          idpCert: "CERT",
          privateKey: "SECRET",
        },
      }),
    ).toThrow("privateKey");
  });

  it("builds standard direct SAML URLs", () => {
    expect(
      directSamlCallbackUrl("https://cocalc.example/auth", "cornell"),
    ).toBe("https://cocalc.example/auth/cornell/return");
    expect(
      directSamlMetadataIssuer("https://cocalc.example/auth", "cornell"),
    ).toBe("https://cocalc.example/auth/cornell/metadata");
  });
});

describe("passportProfileFromSamlProfile", () => {
  it("normalizes common SAML attribute names for PassportLogin", () => {
    const profile = passportProfileFromSamlProfile({
      issuer: "https://idp.example",
      nameID: "persistent-user-id",
      nameIDFormat: "persistent",
      email: "user@example.edu",
      givenName: "Ada",
      sn: "Lovelace",
    });

    expect(profile.id).toBe("persistent-user-id");
    expect(profile.email).toBe("user@example.edu");
    expect(profile.email_verified).toBe(true);
    expect(profile.name).toEqual({
      givenName: "Ada",
      familyName: "Lovelace",
    });
    expect(profile.emails).toEqual([
      { value: "user@example.edu", verified: true },
    ]);
  });

  it("rejects profiles without a stable id", () => {
    expect(() =>
      passportProfileFromSamlProfile({
        issuer: "https://idp.example",
        nameID: "",
        nameIDFormat: "persistent",
      }),
    ).toThrow("stable user id");
  });
});
