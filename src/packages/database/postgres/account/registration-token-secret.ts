/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const REGISTRATION_TOKEN_AAD = "registration_tokens.token";
const HASH_PREFIX = "cocalc-registration-token-hash:v1:";

export function isEncryptedRegistrationTokenValue(
  value?: string | null,
): boolean {
  return isEncryptedSecretSettingValue(value);
}

export function isHashedRegistrationTokenValue(value?: string | null): boolean {
  return !!value && value.startsWith(HASH_PREFIX);
}

export async function encryptRegistrationTokenValue(
  token: string,
): Promise<string> {
  return encryptSecretSettingValue(
    REGISTRATION_TOKEN_AAD,
    token,
    await getSecretSettingsKey(),
  );
}

export async function decryptRegistrationTokenValue(
  storedToken: string,
): Promise<string> {
  if (isHashedRegistrationTokenValue(storedToken)) {
    throw new Error("registration token is hash-only");
  }
  return decryptSecretSettingValue(
    REGISTRATION_TOKEN_AAD,
    storedToken,
    await getSecretSettingsKey(),
  );
}

export async function hashRegistrationTokenValue(
  token: string,
): Promise<string> {
  const digest = createHmac("sha256", await getSecretSettingsKey())
    .update(REGISTRATION_TOKEN_AAD)
    .update("\0")
    .update(token)
    .digest("base64url");
  return `${HASH_PREFIX}${digest}`;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

export async function storedRegistrationTokenMatches(
  storedToken: string,
  token: string,
): Promise<boolean> {
  if (isHashedRegistrationTokenValue(storedToken)) {
    return timingSafeStringEqual(
      storedToken,
      await hashRegistrationTokenValue(token),
    );
  }
  return timingSafeStringEqual(
    await decryptRegistrationTokenValue(storedToken),
    token,
  );
}
