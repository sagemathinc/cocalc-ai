import { secrets } from "@cocalc/backend/data";
import {
  decryptWithAnyKey,
  deriveSiteMasterKeyring,
  getSiteMasterKeyring,
  readOptionalMasterKeyFile,
  resolveLegacyMasterKeyFiles,
  type DerivedSiteKey,
} from "@cocalc/util/master-key-lifecycle";
import {
  isSecretSetting,
  SECRET_SETTING_PREFIX,
} from "@cocalc/util/secret-settings";
import {
  decryptSecretSettingValue as decryptWithKey,
  encryptSecretSettingValue as encryptWithKey,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const SECRET_SETTINGS_PURPOSE = "secret-settings:v1";

let cachedKeys: DerivedSiteKey[] | undefined;
let cachedLegacyKey: Buffer | undefined;
let cachedLegacyKeyLoaded = false;

/**
 * The secret-settings key derived from every site master key: the active one
 * first (the only one used to encrypt or to create keyed hashes), then any
 * staged or retired keys, which are only used to decrypt and to match keyed
 * hashes during a key rotation. Read once per process: a rotation restarts
 * the services that use it.
 */
export async function getSecretSettingsKeys(): Promise<DerivedSiteKey[]> {
  if (cachedKeys) return cachedKeys;
  cachedKeys = deriveSiteMasterKeyring(
    await getSiteMasterKeyring({ secretsDir: secrets }),
    SECRET_SETTINGS_PURPOSE,
  );
  return cachedKeys;
}

export async function getSecretSettingsKey(): Promise<Buffer> {
  return (await getSecretSettingsKeys())[0].key;
}

export function resetSecretSettingsKeysForTesting(): void {
  cachedKeys = undefined;
  cachedLegacyKey = undefined;
  cachedLegacyKeyLoaded = false;
}

async function getLegacySecretSettingsKey(): Promise<Buffer | undefined> {
  if (cachedLegacyKeyLoaded) return cachedLegacyKey;
  cachedLegacyKeyLoaded = true;
  const legacyFile = resolveLegacyMasterKeyFiles({ secretsDir: secrets }).find(
    (file) => file.id === "legacy-secret-settings",
  );
  if (!legacyFile) return undefined;
  cachedLegacyKey = await readOptionalMasterKeyFile(legacyFile.path);
  return cachedLegacyKey;
}

/** The key id recorded in an encrypted value, if any. */
export function secretSettingKeyId(value: string): string | undefined {
  if (!isEncryptedSecretSettingValue(value)) return undefined;
  return value.slice(SECRET_SETTING_PREFIX.length).split(":")[0] || undefined;
}

/**
 * Decrypt a value with whichever secret-settings key encrypted it (the one
 * its key id names first). `key` is undefined when only the legacy key
 * worked.
 */
export async function decryptSecretStorageValueWithKey(
  name: string,
  value: string,
): Promise<{ value: string; key?: DerivedSiteKey }> {
  const keys = await getSecretSettingsKeys();
  try {
    const result = decryptWithAnyKey(
      keys,
      (key) => decryptWithKey(name, value, key),
      secretSettingKeyId(value),
    );
    return { value: result.value, key: result.key };
  } catch (err) {
    const legacyKey = await getLegacySecretSettingsKey();
    if (!legacyKey) throw err;
    try {
      return { value: decryptWithKey(name, value, legacyKey) };
    } catch {
      throw err;
    }
  }
}

export async function encryptSecretStorageValue(
  name: string,
  value: string,
): Promise<string> {
  if (!value) return "";
  if (isEncryptedSecretSettingValue(value)) return value;
  const [active] = await getSecretSettingsKeys();
  return encryptWithKey(name, value, active.key, active.id);
}

export async function decryptSecretStorageValue(
  name: string,
  value: string,
): Promise<{ value: string; needsMigration: boolean }> {
  if (!value) {
    return { value: "", needsMigration: false };
  }
  if (!isEncryptedSecretSettingValue(value)) {
    return { value, needsMigration: true };
  }
  const result = await decryptSecretStorageValueWithKey(name, value);
  // A value under the staged next key was written by a process that already
  // switched to it during a rolling restart: rewrapping it here under the
  // older active key would only undo that.
  return {
    value: result.value,
    needsMigration: result.key == null || result.key.role === "retired",
  };
}

export async function encryptSettingValue(
  name: string,
  value: string,
): Promise<string> {
  if (!isSecretSetting(name)) return value;
  if (!value) return "";
  if (isEncryptedSecretSettingValue(value)) return value;
  return await encryptSecretStorageValue(name, value);
}

export async function decryptSettingValue(
  name: string,
  value: string,
): Promise<{ value: string; needsMigration: boolean }> {
  if (!isSecretSetting(name)) {
    return { value, needsMigration: false };
  }
  if (!value) {
    return { value: "", needsMigration: false };
  }
  return await decryptSecretStorageValue(name, value);
}

/**
 * Keyed hashes (HMACs) cannot be re-encrypted: a lookup or a match has to try
 * the digest under every key until the stored value is recomputed or expires.
 * Returns the digest under each key, the active key's first.
 */
export async function secretSettingsHmacCandidates(
  digest: (key: Buffer) => string,
): Promise<string[]> {
  return [
    ...new Set((await getSecretSettingsKeys()).map(({ key }) => digest(key))),
  ];
}
