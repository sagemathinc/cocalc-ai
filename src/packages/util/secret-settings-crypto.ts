import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SECRET_SETTING_PREFIX } from "./secret-settings";

const DEFAULT_KEY_ID = "default";

export function isEncryptedSecretSettingValue(value?: string | null): boolean {
  if (!value) return false;
  return value.startsWith(SECRET_SETTING_PREFIX);
}

export function encryptSecretSettingValue(
  name: string,
  value: string,
  key: Buffer,
  keyId: string = DEFAULT_KEY_ID,
): string {
  if (!value) return "";
  if (isEncryptedSecretSettingValue(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${SECRET_SETTING_PREFIX}${keyId}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecretSettingValue(
  name: string,
  value: string,
  key: Buffer,
): string {
  if (!isEncryptedSecretSettingValue(value)) return value;
  const payload = value.slice(SECRET_SETTING_PREFIX.length);
  const [keyId, ivB64, tagB64, dataB64] = payload.split(":");
  if (!keyId || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("invalid secret setting format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
