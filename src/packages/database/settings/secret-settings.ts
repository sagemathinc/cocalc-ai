import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { isSecretSetting } from "@cocalc/util/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const logger = getLogger("server:secret-settings");

const DEFAULT_KEY_PATH = join(secrets, "server-settings-key");

let cachedKey: Buffer | undefined;

export async function getSecretSettingsKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const keyPath =
    process.env.COCALC_SECRET_SETTINGS_KEY_PATH ?? DEFAULT_KEY_PATH;
  let encoded = "";
  try {
    encoded = (await readFile(keyPath, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64");
    try {
      await writeFile(keyPath, encoded, { mode: 0o600 });
    } catch (err) {
      throw new Error(`failed to write secret settings key: ${err}`);
    }
    logger.info(`created secret settings key at ${keyPath}`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid secret settings key length at ${keyPath}`);
  }
  cachedKey = key;
  return key;
}

export async function encryptSettingValue(
  name: string,
  value: string,
): Promise<string> {
  if (!isSecretSetting(name)) return value;
  if (!value) return "";
  if (isEncryptedSecretSettingValue(value)) return value;
  const key = await getSecretSettingsKey();
  return encryptSecretSettingValue(name, value, key);
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
  if (isEncryptedSecretSettingValue(value)) {
    const key = await getSecretSettingsKey();
    return {
      value: decryptSecretSettingValue(name, value, key),
      needsMigration: false,
    };
  }
  return { value, needsMigration: true };
}
