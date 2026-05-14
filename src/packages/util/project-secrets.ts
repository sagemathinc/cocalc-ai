/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export {
  PROJECT_ENV_KEY_MAX_LENGTH,
  PROJECT_ENV_MAX_COUNT,
  PROJECT_ENV_TOTAL_MAX_BYTES,
  PROJECT_ENV_VALUE_MAX_BYTES,
  PROJECT_SECRETS_ENV,
  PROJECT_SECRETS_KEY_ID,
  PROJECT_SECRETS_MAX_COUNT,
  PROJECT_SECRETS_MOUNT_PATH,
  PROJECT_SECRETS_PURPOSE,
  PROJECT_SECRET_NAME_MAX_LENGTH,
  PROJECT_SECRET_VALUE_MAX_BYTES,
} from "./project-secrets-constants";
import {
  PROJECT_ENV_MAX_COUNT,
  PROJECT_ENV_TOTAL_MAX_BYTES,
  PROJECT_ENV_VALUE_MAX_BYTES,
  PROJECT_SECRETS_ENV,
  PROJECT_SECRETS_KEY_ID,
  PROJECT_SECRETS_PURPOSE,
  PROJECT_SECRET_VALUE_MAX_BYTES,
} from "./project-secrets-constants";

const SECRET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface EncryptedProjectSecretValue {
  key_id: typeof PROJECT_SECRETS_KEY_ID;
  purpose: typeof PROJECT_SECRETS_PURPOSE;
  cipher: "aes-256-gcm";
  iv_base64: string;
  tag_base64: string;
  data_base64: string;
  created_at: string;
}

export interface ProjectSecretRuntimeCacheEntry {
  name: string;
  encrypted_value: EncryptedProjectSecretValue;
  value_bytes: number;
  updated_at?: string | number;
}

export interface ProjectSecretsRuntimeCache {
  key_base64: string;
  entries: ProjectSecretRuntimeCacheEntry[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeProjectSecretName(name: string): string {
  const normalized = `${name ?? ""}`.trim();
  if (!SECRET_NAME_RE.test(normalized)) {
    throw new Error(
      `invalid project secret name '${name}'; use letters, numbers, '_', '.', or '-', starting with a letter, number, or '_'`,
    );
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("..")
  ) {
    throw new Error(`invalid project secret name '${name}'`);
  }
  return normalized;
}

export function validateProjectSecretValue(value: string): number {
  const size = byteLength(value);
  if (size > PROJECT_SECRET_VALUE_MAX_BYTES) {
    throw new Error(
      `project secret value is too large (${size}/${PROJECT_SECRET_VALUE_MAX_BYTES} bytes)`,
    );
  }
  return size;
}

function aad({
  project_id,
  name,
}: {
  project_id: string;
  name: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: PROJECT_SECRETS_PURPOSE,
      project_id,
      name,
    }),
    "utf8",
  );
}

export function encryptProjectSecretValue({
  project_id,
  name,
  value,
  key,
}: {
  project_id: string;
  name: string;
  value: string;
  key: Buffer;
}): EncryptedProjectSecretValue {
  const normalizedName = normalizeProjectSecretName(name);
  validateProjectSecretValue(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad({ project_id, name: normalizedName }));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    key_id: PROJECT_SECRETS_KEY_ID,
    purpose: PROJECT_SECRETS_PURPOSE,
    cipher: "aes-256-gcm",
    iv_base64: iv.toString("base64"),
    tag_base64: cipher.getAuthTag().toString("base64"),
    data_base64: encrypted.toString("base64"),
    created_at: new Date().toISOString(),
  };
}

export function decryptProjectSecretValue({
  project_id,
  name,
  encrypted,
  key,
}: {
  project_id: string;
  name: string;
  encrypted: EncryptedProjectSecretValue;
  key: Buffer;
}): string {
  const normalizedName = normalizeProjectSecretName(name);
  if (
    encrypted?.key_id !== PROJECT_SECRETS_KEY_ID ||
    encrypted?.purpose !== PROJECT_SECRETS_PURPOSE ||
    encrypted?.cipher !== "aes-256-gcm"
  ) {
    throw new Error("invalid project secret encrypted value");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv_base64, "base64"),
  );
  decipher.setAAD(aad({ project_id, name: normalizedName }));
  decipher.setAuthTag(Buffer.from(encrypted.tag_base64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.data_base64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function validateProjectEnv(env: Record<string, string> | null): void {
  if (env == null) return;
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new Error("project environment must be an object");
  }
  const entries = Object.entries(env);
  if (entries.length > PROJECT_ENV_MAX_COUNT) {
    throw new Error(
      `too many project environment variables (${entries.length}/${PROJECT_ENV_MAX_COUNT})`,
    );
  }
  let total = 0;
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`invalid project environment variable name '${key}'`);
    }
    if (key === PROJECT_SECRETS_ENV) {
      throw new Error(`${PROJECT_SECRETS_ENV} is managed by CoCalc`);
    }
    if (key.startsWith("COCALC_")) {
      throw new Error(
        `project environment variable '${key}' is reserved by CoCalc`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(`project environment variable '${key}' must be a string`);
    }
    const valueBytes = byteLength(value);
    if (valueBytes > PROJECT_ENV_VALUE_MAX_BYTES) {
      throw new Error(
        `project environment variable '${key}' is too large (${valueBytes}/${PROJECT_ENV_VALUE_MAX_BYTES} bytes)`,
      );
    }
    total += byteLength(key) + valueBytes;
  }
  if (total > PROJECT_ENV_TOTAL_MAX_BYTES) {
    throw new Error(
      `project environment is too large (${total}/${PROJECT_ENV_TOTAL_MAX_BYTES} bytes)`,
    );
  }
}
