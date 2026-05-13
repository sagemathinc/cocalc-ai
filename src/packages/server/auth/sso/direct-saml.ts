/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Profile, SamlConfig } from "@node-saml/passport-saml";
import { ValidateInResponseTo } from "@node-saml/passport-saml";
import ms from "ms";

import type { PassportStrategyDBConfig } from "@cocalc/database/settings/auth-sso-types";

const DEFAULT_NAME_ID_FORMAT =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

const EMAIL_KEYS = [
  "email",
  "mail",
  "emailAddress",
  "Email",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
] as const;

const FIRST_NAME_KEYS = [
  "first_name",
  "givenName",
  "given_name",
  "FirstName",
  "urn:oid:2.5.4.42",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
] as const;

const LAST_NAME_KEYS = [
  "last_name",
  "sn",
  "surname",
  "family_name",
  "LastName",
  "urn:oid:2.5.4.4",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
] as const;

const ID_KEYS = [
  "nameID",
  "id",
  "uid",
  "eduPersonPrincipalName",
  ...EMAIL_KEYS,
] as const;

export interface DirectSamlConfigOpts {
  name: string;
  authUrl: string;
  config: PassportStrategyDBConfig;
  cacheProvider: any;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text.length > 0 ? text : undefined;
}

function requiredString(value: unknown, field: string): string {
  const text = stringOrUndefined(value);
  if (!text) {
    throw new Error(`SAML provider config is missing required '${field}'.`);
  }
  return text;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstString(item);
      if (text) return text;
    }
    return undefined;
  }
  return stringOrUndefined(value);
}

function firstProfileString(
  profile: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const text = firstString(profile[key]);
    if (text) return text;
  }
  return undefined;
}

function numberOrDefault(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function idpCert(value: unknown): string | string[] {
  if (Array.isArray(value)) {
    const certs = value.map(stringOrUndefined).filter(Boolean) as string[];
    if (certs.length > 0) return certs;
  }
  return requiredString(value, "idpCert");
}

export function directSamlCallbackUrl(authUrl: string, name: string): string {
  return `${authUrl}/${name}/return`;
}

export function directSamlMetadataIssuer(
  authUrl: string,
  name: string,
): string {
  return `${authUrl}/${name}/metadata`;
}

export function directSamlConfig({
  name,
  authUrl,
  config,
  cacheProvider,
}: DirectSamlConfigOpts): SamlConfig {
  if (config.privateKey != null || config.decryptionPvk != null) {
    throw new Error(
      "Direct SAML providers do not accept privateKey or decryptionPvk in sso_providers.config.",
    );
  }

  const issuer =
    stringOrUndefined(config.issuer) ?? directSamlMetadataIssuer(authUrl, name);
  const callbackUrl =
    stringOrUndefined(config.callbackUrl) ??
    directSamlCallbackUrl(authUrl, name);
  const audience =
    config.audience === false
      ? false
      : (stringOrUndefined(config.audience) ?? issuer);
  const cachedMS = ms("8 hours");

  return {
    acceptedClockSkewMs: numberOrDefault(
      config.acceptedClockSkewMs,
      ms("5 minutes"),
      0,
      ms("30 minutes"),
    ),
    audience,
    cacheProvider,
    callbackUrl,
    digestAlgorithm: "sha256",
    entryPoint: requiredString(config.entryPoint, "entryPoint"),
    identifierFormat:
      config.identifierFormat === null
        ? null
        : (stringOrUndefined(config.identifierFormat) ??
          DEFAULT_NAME_ID_FORMAT),
    idpCert: idpCert(config.idpCert ?? config.cert),
    issuer,
    requestIdExpirationPeriodMs: numberOrDefault(
      config.requestIdExpirationPeriodMs,
      cachedMS,
      ms("5 minutes"),
      ms("24 hours"),
    ),
    signatureAlgorithm: "sha256",
    validateInResponseTo: ValidateInResponseTo.always,
    wantAssertionsSigned: config.wantAssertionsSigned !== false,
    wantAuthnResponseSigned: config.wantAuthnResponseSigned === true,
  };
}

export function passportProfileFromSamlProfile(profile: Profile): any {
  const raw = profile as Record<string, unknown>;
  const email = firstProfileString(raw, EMAIL_KEYS);
  const id = firstProfileString(raw, ID_KEYS);
  if (!id) {
    throw new Error("SAML profile did not include a stable user id.");
  }
  const firstName = firstProfileString(raw, FIRST_NAME_KEYS);
  const lastName = firstProfileString(raw, LAST_NAME_KEYS);
  const normalized = {
    ...profile,
    id,
    email,
    email_verified: email != null,
    name: {
      givenName: firstName ?? "",
      familyName: lastName ?? "",
    },
    _json: {
      ...profile,
      email,
      email_verified: email != null,
    },
  };
  if (email != null) {
    normalized["emails"] = [{ value: email, verified: true }];
  }
  return normalized;
}
