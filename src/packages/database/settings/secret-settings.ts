import { secrets } from "@cocalc/backend/data";
import {
  deriveSiteMasterKey,
  getOrCreateSiteMasterKey,
  readOptionalMasterKeyFile,
  resolveLegacyMasterKeyFiles,
} from "@cocalc/util/master-key-lifecycle";
import { isSecretSetting } from "@cocalc/util/secret-settings";
import {
  decryptSecretSettingValue as decryptWithKey,
  encryptSecretSettingValue as encryptWithKey,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const SECRET_SETTINGS_PURPOSE = "secret-settings:v1";
const SECRET_SETTINGS_KEY_ID = "site-master-key-v1";

let cachedKey: Buffer | undefined;
let cachedLegacyKey: Buffer | undefined;
let cachedLegacyKeyLoaded = false;

export async function getSecretSettingsKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  cachedKey = deriveSiteMasterKey(
    await getOrCreateSiteMasterKey({ secretsDir: secrets }),
    SECRET_SETTINGS_PURPOSE,
  );
  return cachedKey;
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

export async function encryptSecretStorageValue(
  name: string,
  value: string,
): Promise<string> {
  if (!value) return "";
  if (isEncryptedSecretSettingValue(value)) return value;
  return encryptWithKey(
    name,
    value,
    await getSecretSettingsKey(),
    SECRET_SETTINGS_KEY_ID,
  );
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
  const key = await getSecretSettingsKey();
  try {
    return { value: decryptWithKey(name, value, key), needsMigration: false };
  } catch (err) {
    const legacyKey = await getLegacySecretSettingsKey();
    if (!legacyKey) throw err;
    try {
      return {
        value: decryptWithKey(name, value, legacyKey),
        needsMigration: true,
      };
    } catch {
      throw err;
    }
  }
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
