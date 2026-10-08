/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  decryptProjectSecretValue,
  type ProjectSecretsRuntimeCache,
} from "@cocalc/util/project-secrets";
import {
  getCachedProjectSecretsState,
  getCachedProjectSecrets,
  markCachedProjectSecretsMaterialized,
  replaceCachedProjectSecrets,
} from "./sqlite/project-secrets";

// The hub sends the current key with every sync. After a site master key
// rotation, values cached for projects that have not re-synced yet are still
// under the previous key, so the last few keys are kept (newest first) and
// tried in turn; AES-GCM authentication rejects a wrong key.
const MAX_PROJECT_SECRETS_KEYS = 4;
let projectSecretsKeys: Buffer[] = [];

export function hasProjectSecretsCacheKey(): boolean {
  return projectSecretsKeys.length > 0;
}

export function resetProjectSecretsCacheKeyForTesting(): void {
  projectSecretsKeys = [];
}

export function setProjectSecretsCacheKey(key_base64: string): void {
  const key = Buffer.from(`${key_base64 ?? ""}`, "base64");
  if (key.length !== 32) {
    throw new Error("invalid project secrets cache key");
  }
  projectSecretsKeys = [
    key,
    ...projectSecretsKeys.filter((other) => !other.equals(key)),
  ].slice(0, MAX_PROJECT_SECRETS_KEYS);
}

function decryptCached({
  project_id,
  name,
  encrypted,
}: {
  project_id: string;
  name: string;
  encrypted: Parameters<typeof decryptProjectSecretValue>[0]["encrypted"];
}): string {
  let firstError: unknown;
  for (const key of projectSecretsKeys) {
    try {
      return decryptProjectSecretValue({ project_id, name, encrypted, key });
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError;
}

export function syncProjectSecretsCache({
  project_id,
  cache,
}: {
  project_id: string;
  cache: ProjectSecretsRuntimeCache;
}): {
  accepted: boolean;
  secret_names: string[];
  cached_generation: number;
  materialized_generation: number;
} {
  setProjectSecretsCacheKey(cache.key_base64);
  const current = getCachedProjectSecretsState(project_id);
  // Older hubs did not include a generation. Treat each legacy snapshot as a
  // new local generation so a project-host can be upgraded before the hub, or
  // continue serving safely if the hub is rolled back.
  const generation =
    Number.isSafeInteger(cache.generation) && cache.generation >= 0
      ? cache.generation
      : current.cached_generation + 1;
  const { accepted, state } = replaceCachedProjectSecrets({
    project_id,
    generation,
    entries: cache.entries,
  });
  return {
    accepted,
    secret_names: getCachedProjectSecrets(project_id)
      .map(({ name }) => name)
      .sort(),
    cached_generation: state.cached_generation,
    materialized_generation: state.materialized_generation,
  };
}

export function getProjectSecretsCacheState(project_id: string) {
  return getCachedProjectSecretsState(project_id);
}

export function markProjectSecretsCacheMaterialized({
  project_id,
  generation,
}: {
  project_id: string;
  generation: number;
}) {
  return markCachedProjectSecretsMaterialized({ project_id, generation });
}

export function getCachedProjectSecretsForRuntime({
  project_id,
}: {
  project_id: string;
}): Record<string, string> | undefined {
  if (projectSecretsKeys.length === 0) {
    return undefined;
  }
  const rows = getCachedProjectSecrets(project_id);
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      decryptCached({
        project_id,
        name: row.name,
        encrypted: row.encrypted_value,
      }),
    ]),
  );
}
