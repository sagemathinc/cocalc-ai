/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  decryptProjectSecretValue,
  type ProjectSecretsRuntimeCache,
} from "@cocalc/util/project-secrets";
import {
  getCachedProjectSecrets,
  replaceCachedProjectSecrets,
} from "./sqlite/project-secrets";

let projectSecretsKey: Buffer | undefined;

export function hasProjectSecretsCacheKey(): boolean {
  return projectSecretsKey != null;
}

export function resetProjectSecretsCacheKeyForTesting(): void {
  projectSecretsKey = undefined;
}

export function setProjectSecretsCacheKey(key_base64: string): void {
  const key = Buffer.from(`${key_base64 ?? ""}`, "base64");
  if (key.length !== 32) {
    throw new Error("invalid project secrets cache key");
  }
  projectSecretsKey = key;
}

export function syncProjectSecretsCache({
  project_id,
  cache,
}: {
  project_id: string;
  cache: ProjectSecretsRuntimeCache;
}): string[] {
  setProjectSecretsCacheKey(cache.key_base64);
  replaceCachedProjectSecrets({
    project_id,
    entries: cache.entries,
  });
  return cache.entries.map(({ name }) => name).sort();
}

export function getCachedProjectSecretsForRuntime({
  project_id,
}: {
  project_id: string;
}): Record<string, string> | undefined {
  if (!projectSecretsKey) {
    return undefined;
  }
  const rows = getCachedProjectSecrets(project_id);
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      decryptProjectSecretValue({
        project_id,
        name: row.name,
        encrypted: row.encrypted_value,
        key: projectSecretsKey!,
      }),
    ]),
  );
}
