/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import {
  getSecretSettingsKeys,
  secretSettingKeyId,
} from "@cocalc/database/settings/secret-settings";
import {
  decryptWithAnyKey,
  type DerivedSiteKey,
} from "@cocalc/util/master-key-lifecycle";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

type EmailAuthSecretKind = "browser" | "code" | "email" | "ip" | "link";

const REGISTRATION_TOKEN_SECRET_NAME =
  "email_auth_challenges.registration_token";

let cachedKeys: DerivedSiteKey[] | undefined;

// One email-auth subkey per site master key in the keyring, the active one
// first. Digests are created with the active key; matching and lookups accept
// any key, so a challenge started just before a key rotation still works.
async function emailAuthKeys(): Promise<DerivedSiteKey[]> {
  if (cachedKeys) {
    return cachedKeys;
  }
  cachedKeys = (await getSecretSettingsKeys()).map(({ id, role, key }) => ({
    id,
    role,
    key: createHmac("sha256", key)
      .update("cocalc-email-auth:v1", "utf8")
      .digest(),
  }));
  return cachedKeys;
}

type DigestInput = {
  challenge_id?: string;
  kind: EmailAuthSecretKind;
  value: string;
};

function digestWith(key: Buffer, { challenge_id, kind, value }: DigestInput) {
  return createHmac("sha256", key)
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(`${challenge_id ?? ""}`, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

/** The digest to store, under the active key. */
export async function emailAuthDigest(input: DigestInput): Promise<string> {
  return digestWith((await emailAuthKeys())[0].key, input);
}

/** The digest under every key, the active key's first: for lookups. */
export async function emailAuthDigestCandidates(
  input: DigestInput,
): Promise<string[]> {
  return [
    ...new Set(
      (await emailAuthKeys()).map(({ key }) => digestWith(key, input)),
    ),
  ];
}

export async function emailAuthSecretMatches(opts: {
  challenge_id?: string;
  digest: string;
  kind: EmailAuthSecretKind;
  value: string;
}): Promise<boolean> {
  const expected = Buffer.from(opts.digest, "hex");
  let matches = false;
  for (const candidate of await emailAuthDigestCandidates(opts)) {
    const actual = Buffer.from(candidate, "hex");
    matches =
      (actual.length === expected.length &&
        timingSafeEqual(actual, expected)) ||
      matches;
  }
  return matches;
}

export function createEmailAuthCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function createEmailAuthLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createEmailAuthBrowserBinding(): string {
  return randomBytes(24).toString("base64url");
}

export async function encryptEmailAuthRegistrationToken(
  token: string,
): Promise<string> {
  const [active] = await emailAuthKeys();
  return encryptSecretSettingValue(
    REGISTRATION_TOKEN_SECRET_NAME,
    token,
    active.key,
    active.id,
  );
}

export async function decryptEmailAuthRegistrationToken(
  encrypted: string,
): Promise<string> {
  return decryptWithAnyKey(
    await emailAuthKeys(),
    (key) =>
      decryptSecretSettingValue(REGISTRATION_TOKEN_SECRET_NAME, encrypted, key),
    secretSettingKeyId(encrypted),
  ).value;
}

export function maskEmailAddress(email_address: string): string {
  const [local = "", domain = ""] = email_address.split("@");
  if (!local || !domain) {
    return "***";
  }
  const visible =
    local.length <= 2 ? local.slice(0, 1) : `${local.slice(0, 2)}…`;
  return `${visible}@${domain}`;
}

export function resetEmailAuthKeyForTesting(): void {
  cachedKeys = undefined;
}
