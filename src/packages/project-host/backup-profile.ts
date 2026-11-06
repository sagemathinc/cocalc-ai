/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ProjectBackupConfig,
  ProjectBackupIndexStoreConfig,
} from "@cocalc/conat/hub/api/hosts";

// Remove a project's cached backup profile, and say what happened: removed,
// absent (none existed) or failed. Only ENOENT means absent; any other error
// is a failure, never reported as absent.
export async function removeBackupProfile(
  profilePath: string,
): Promise<{ profile: "removed" | "absent" | "failed"; error?: unknown }> {
  try {
    await lstat(profilePath);
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return { profile: "absent" };
    return { profile: "failed", error: err };
  }
  try {
    await rm(profilePath);
    return { profile: "removed" };
  } catch (err) {
    // removed meanwhile, e.g. by a concurrent invalidation
    if ((err as any)?.code === "ENOENT") return { profile: "absent" };
    return { profile: "failed", error: err };
  }
}

// Publishing and invalidating the cached backup profiles, so that an
// invalidation also stops a fetch that was already in flight: once
// invalidate() returns, no profile fetched before it can be (or stay) on disk.
//
// - A fetch takes a token before it asks for the configuration. invalidate()
//   advances the project's generation first, synchronously, so every older
//   token is stale from then on.
// - publish() writes a temp file and renames it into place, checking the token
//   before the write, before the rename and after it; a stale publish removes
//   what it renamed.
// - A project's publishes and its removal run one at a time, in call order, so
//   invalidate()'s removal runs after any publish that started before it.
export class BackupProfiles {
  private allGeneration = 0;
  private generations = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();

  constructor(
    // test hooks: around the rename
    private readonly hooks: {
      beforeRename?: () => Promise<void>;
      afterRename?: () => Promise<void>;
    } = {},
  ) {}

  token(project_id: string): string {
    return `${this.allGeneration}:${this.generations.get(project_id) ?? 0}`;
  }

  isCurrent(project_id: string, token: string): boolean {
    return this.token(project_id) === token;
  }

  // Write the profile, unless it was invalidated since the token was taken;
  // true if it is now in place under that token.
  async publish({
    project_id,
    token,
    profilePath,
    toml,
  }: {
    project_id: string;
    token: string;
    profilePath: string;
    toml: string;
  }): Promise<boolean> {
    if (!this.isCurrent(project_id, token)) return false;
    return await this.serialize(project_id, async () => {
      if (!this.isCurrent(project_id, token)) return false;
      await mkdir(dirname(profilePath), { recursive: true });
      const tmp = `${profilePath}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, toml, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await this.hooks.beforeRename?.();
        if (!this.isCurrent(project_id, token)) return false;
        await rename(tmp, profilePath);
        await this.hooks.afterRename?.();
        if (!this.isCurrent(project_id, token)) {
          // invalidated during the rename: take it back
          await rm(profilePath, { force: true });
          return false;
        }
        return true;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    });
  }

  // Invalidate one project's profile and remove it, after any publish that
  // started before this call. The generation advances before this returns
  // its promise, so callers can rely on older tokens being stale at once.
  invalidate(
    project_id: string,
    profilePath: string,
  ): Promise<{ profile: "removed" | "absent" | "failed"; error?: unknown }> {
    this.generations.set(
      project_id,
      (this.generations.get(project_id) ?? 0) + 1,
    );
    return this.serialize(project_id, () => removeBackupProfile(profilePath));
  }

  // Every project's token is stale from now on (in-flight publishes take
  // theirs back); the files are left to each project's own invalidation.
  invalidateAll(): void {
    this.allGeneration += 1;
  }

  private serialize<T>(project_id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(project_id) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.chains.set(project_id, tail);
    void tail.then(() => {
      if (this.chains.get(project_id) === tail) this.chains.delete(project_id);
    });
    return result;
  }
}

// The host's answer to the hub's invalidateBackupConfig: ok, plus what
// happened to the profile only when it is one of the three known outcomes.
// Nothing else, and no error text, goes back to the hub.
export function invalidateBackupConfigReply(
  result: { profile?: unknown } | null | undefined,
): { ok: true; profile?: "removed" | "absent" | "failed" } {
  const profile = result?.profile;
  return profile === "removed" || profile === "absent" || profile === "failed"
    ? { ok: true, profile }
    : { ok: true };
}

// A fetch that an invalidation overtook: its configuration must not be used.
export class BackupConfigInvalidatedError extends Error {}

export interface CachedBackupConfig {
  toml: string;
  expiresAt: number;
  path: string;
  index_store?: ProjectBackupIndexStoreConfig | null;
}

// The host's backup configurations: fetched from the hub, published as the
// project's profile and cached until they expire or are invalidated. A fetch
// that an invalidation overtakes is never published, cached or used.
export class BackupConfigs {
  private cache = new Map<string, CachedBackupConfig>();
  readonly profiles: BackupProfiles;

  constructor(
    private readonly opts: {
      fetch: (project_id: string) => Promise<ProjectBackupConfig | null>;
      profilePath: (project_id: string) => string;
      profiles?: BackupProfiles;
      retryMs?: number;
      timeoutMs?: number;
      onRetry?: (info: {
        project_id: string;
        attempt: number;
        remaining_ms: number;
        err: string;
      }) => void;
      onRemovalFailed?: (info: { project_id: string; err: string }) => void;
    },
  ) {
    this.profiles = opts.profiles ?? new BackupProfiles();
  }

  cached(project_id: string): CachedBackupConfig | undefined {
    const cached = this.cache.get(project_id);
    return cached && Date.now() < cached.expiresAt ? cached : undefined;
  }

  // For one project, also reports its profile: removed, absent (none existed)
  // or failed (see removeBackupProfile). The cache entry goes in every case,
  // and a fetch already in flight can't bring either back.
  async invalidate(
    project_id?: string,
  ): Promise<{ profile?: "removed" | "absent" | "failed"; error?: unknown }> {
    if (!project_id) {
      this.profiles.invalidateAll();
      this.cache.clear();
      return {};
    }
    // advances the project's generation before anything else happens
    const removal = this.profiles.invalidate(
      project_id,
      this.opts.profilePath(project_id),
    );
    this.cache.delete(project_id);
    const result = await removal;
    if (result.profile === "failed") {
      this.opts.onRemovalFailed?.({ project_id, err: `${result.error}` });
    }
    return result;
  }

  // The project's profile path, or null if it has no backup configuration.
  async ensure(project_id: string): Promise<string | null> {
    const cached = this.cached(project_id);
    if (cached) return cached.path;
    const profilePath = this.opts.profilePath(project_id);
    const retryMs = this.opts.retryMs ?? 5000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 2 * 60 * 1000);
    let attempt = 0;
    while (true) {
      attempt += 1;
      // taken before the fetch: an invalidation meanwhile makes it stale
      const token = this.profiles.token(project_id);
      try {
        const remoteConfig = await this.opts.fetch(project_id);
        const toml = remoteConfig?.toml;
        if (!toml) return null;
        const ttlSeconds = remoteConfig?.ttl_seconds ?? 0;
        if (
          !(await this.profiles.publish({
            project_id,
            token,
            profilePath,
            toml,
          })) ||
          !this.profiles.isCurrent(project_id, token)
        ) {
          throw new BackupConfigInvalidatedError(
            "backup configuration was invalidated while it was being fetched",
          );
        }
        // checked and set in one synchronous step
        const fetchedAt = Date.now();
        this.cache.set(project_id, {
          toml,
          expiresAt:
            ttlSeconds > 0
              ? fetchedAt + ttlSeconds * 1000
              : fetchedAt + 3600 * 1000,
          path: profilePath,
          index_store: remoteConfig?.index_store,
        });
        return profilePath;
      } catch (err) {
        if (err instanceof BackupConfigInvalidatedError) throw err;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(
            `backup config fetch failed after ${attempt} attempt(s): ${err}`,
          );
        }
        this.opts.onRetry?.({
          project_id,
          attempt,
          remaining_ms: remainingMs,
          err: `${err}`,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(retryMs, remainingMs)),
        );
      }
    }
  }
}
