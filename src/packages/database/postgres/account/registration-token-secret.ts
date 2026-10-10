/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  decryptSecretStorageValueWithKey,
  encryptSecretStorageValue,
  getSecretSettingsKey,
  secretSettingsHmacCandidates,
} from "@cocalc/database/settings/secret-settings";
import { isEncryptedSecretSettingValue } from "@cocalc/util/secret-settings-crypto";

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
  return await encryptSecretStorageValue(REGISTRATION_TOKEN_AAD, token);
}

export async function decryptRegistrationTokenValue(
  storedToken: string,
): Promise<string> {
  if (isHashedRegistrationTokenValue(storedToken)) {
    throw new Error("registration token is hash-only");
  }
  if (!isEncryptedSecretSettingValue(storedToken)) return storedToken;
  return (
    await decryptSecretStorageValueWithKey(REGISTRATION_TOKEN_AAD, storedToken)
  ).value;
}

export async function canReadRegistrationTokenValue(
  storedToken: string,
): Promise<boolean> {
  if (isHashedRegistrationTokenValue(storedToken)) {
    return true;
  }
  try {
    await decryptRegistrationTokenValue(storedToken);
    return true;
  } catch {
    return false;
  }
}

function registrationTokenHash(key: Buffer, token: string): string {
  const digest = createHmac("sha256", key)
    .update(REGISTRATION_TOKEN_AAD)
    .update("\0")
    .update(token)
    .digest("base64url");
  return `${HASH_PREFIX}${digest}`;
}

/** The stored form of a hash-only token, under the active key. */
export async function hashRegistrationTokenValue(
  token: string,
): Promise<string> {
  return registrationTokenHash(await getSecretSettingsKey(), token);
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
    // A hash made under a key that has since been rotated still matches
    // while that key is in the keyring.
    let matches = false;
    for (const candidate of await secretSettingsHmacCandidates((key) =>
      registrationTokenHash(key, token),
    )) {
      matches = timingSafeStringEqual(storedToken, candidate) || matches;
    }
    return matches;
  }
  try {
    return timingSafeStringEqual(
      await decryptRegistrationTokenValue(storedToken),
      token,
    );
  } catch {
    // Stale encrypted rows can exist after a site key reset or database copy.
    // They must not prevent validation of other active registration tokens.
    return false;
  }
}
