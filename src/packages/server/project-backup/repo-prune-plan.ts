/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A read-only prune plan for one shared project-backup repository.

Nothing prunes the shared repositories yet: purges and retention only
`rustic forget`, so the data of forgotten snapshots stays in the bucket. To
size that backlog and choose between strict (`--max-unused 0`) and bounded
pruning, an admin runs `rustic --dry-run prune` on a few repositories. This
does that through the same temporary-profile path as the health probe
(repo-health.ts), so no one builds profiles with repository secrets by hand.

`--dry-run` is fixed: nothing here can delete, repack or write to the
repository. Options are limited to --max-unused and --max-repack, and their
values are validated. One plan runs at a time on a bay.
*/

import { existsSync } from "node:fs";

import exec from "@cocalc/backend/sandbox/exec";
import { rustic as defaultRusticPath } from "@cocalc/backend/sandbox/install";
import getLogger from "@cocalc/backend/logger";
import centralLog from "@cocalc/database/postgres/central-log";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  ProjectBackupRepoPrunePlan,
  ProjectBackupRepoPruneStatsEntry as PruneStatsEntry,
} from "@cocalc/conat/hub/api/system";
import { isValidUUID } from "@cocalc/util/misc";
import {
  ensureProjectBackupRepoSchema,
  getProjectBackupConfigForRepo,
} from "./index";
import {
  PRUNE_PLAN_PROFILE_PREFIX,
  profileSecrets,
  summarizeRusticError,
  withRepoProfile,
  type ProbeDeps,
} from "./repo-health";

export const PRUNE_PLAN_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const PRUNE_PLAN_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PRUNE_PLAN_MAX_OUTPUT_BYTES = 1024 * 1024;
const REPOINFO_TIMEOUT_MS = 10 * 60 * 1000;
// repoinfo is skipped if less than this is left of the run's time budget.
const REPOINFO_MIN_BUDGET_MS = 30 * 1000;
const NICE = "/usr/bin/nice";

// rustic accepts a percentage, a size, or "unlimited".
const LIMIT_PATTERN =
  /^(unlimited|\d+(\.\d+)?%|\d+(\.\d+)?\s*([kmgt]i?b|b)?)$/i;

// By lowercased unit: rustic's byte formatting has printed both "KiB" and
// "kiB" across versions, so the case of a unit is not significant.
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

export function bytesOf(text: string): number | undefined {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([kmgt]i?b|b)\b/gi)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return Math.round(Number(last[1]) * UNIT_BYTES[last[2].toLowerCase()]);
}

// Parse rustic's prune statistics, e.g.
//   [INFO] to delete:          2 packs,          6 blobs,    1.9 MiB
//   [INFO] unused size after prune:        0 B (0.00% of remaining size)
//   [INFO]  - complete deletion:               0,        0 B
export function parseRusticPruneStats(stderr: string): {
  stats: Record<string, PruneStatsEntry>;
  lines: string[];
} {
  const stats: Record<string, PruneStatsEntry> = {};
  const lines: string[] = [];
  for (const raw of stderr
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")) {
    const line = raw.replace(/^\s*\[[A-Z]+\]\s*/, "").trimEnd();
    const m = line.match(/^\s*(?:-\s*)?([a-z][a-z ]+?):\s+(.*)$/);
    if (!m) continue;
    const key = m[1].trim().replace(/\s+/g, "_");
    const rest = m[2];
    if (
      ![
        "to_repack",
        "this_removes",
        "to_delete",
        // Packs in no index (e.g. from an interrupted upload): rustic
        // prints it only when there are some, with "??" blobs.
        "unindexed",
        "total_prune",
        "remaining",
        "unused_size_after_prune",
        "packs_marked_for_deletion",
        "complete_deletion",
        "keep_marked",
        "recover",
      ].includes(key)
    ) {
      continue;
    }
    const entry: PruneStatsEntry = {};
    const packs = rest.match(/(\d+)\s+packs?\b/);
    const blobs = rest.match(/(\d+)\s+blobs?\b/);
    // "packs marked for deletion: N, SIZE" and its sub-lines count packs.
    const leadingCount = rest.match(/^\s*(\d+),/);
    if (packs) entry.packs = Number(packs[1]);
    else if (leadingCount && !blobs) entry.packs = Number(leadingCount[1]);
    if (blobs) entry.blobs = Number(blobs[1]);
    const bytes = bytesOf(rest);
    if (bytes != null) entry.bytes = bytes;
    const percent = rest.match(/\(([\d.]+)%/);
    if (percent) entry.percent = Number(percent[1]);
    stats[key] = entry;
    lines.push(line.trim());
  }
  return { stats, lines };
}

function averageDataPackBytes(repoinfo: any): number | null {
  const packs = repoinfo?.index?.packs;
  if (!Array.isArray(packs)) return null;
  const data = packs.find((p: any) => p?.blob_type === "data");
  const min = Number(data?.min_size);
  const max = Number(data?.max_size);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
  return (min + max) / 2;
}

export type { ProjectBackupRepoPrunePlan };

export function estimatePruneCost(
  stats: Record<string, PruneStatsEntry>,
  repoinfo?: unknown,
): ProjectBackupRepoPrunePlan["estimate"] {
  const repack = stats.to_repack;
  const removes = stats.this_removes;
  const del = stats.to_delete;
  const unindexed = stats.unindexed;
  const total = stats.total_prune;
  const repackRead = repack?.bytes ?? null;
  const repackWrite =
    repackRead == null ? null : Math.max(0, repackRead - (removes?.bytes ?? 0));
  const packSize = averageDataPackBytes(repoinfo);
  return {
    repack_read_bytes: repackRead,
    repack_write_bytes: repackWrite,
    // rustic's total prune size already includes the unindexed packs.
    eventually_freed_bytes: total?.bytes ?? null,
    packs_read: repack?.packs ?? null,
    packs_marked_for_deletion:
      repack?.packs == null && del?.packs == null
        ? null
        : (repack?.packs ?? 0) + (del?.packs ?? 0) + (unindexed?.packs ?? 0),
    removed_now_packs: stats.complete_deletion?.packs ?? null,
    removed_now_bytes: stats.complete_deletion?.bytes ?? null,
    class_a_ops:
      repackWrite == null || packSize == null
        ? null
        : Math.ceil(repackWrite / packSize) + 1,
    class_b_ops_min: repack?.packs ?? null,
    note: "Rough, from rustic's rounded sizes. A real prune with the same options repacks the partially used packs now (Class B reads, Class A writes; R2 charges no egress and no deletes) but only marks the obsolete packs: they are removed, and their bytes freed, by a later prune after --keep-delete. It removes now only packs marked by an earlier prune.",
  };
}

export function validatePruneLimit(
  name: string,
  value?: string | null,
): string | null {
  const v = `${value ?? ""}`.trim();
  if (!v) return null;
  if (!LIMIT_PATTERN.test(v)) {
    throw new Error(
      `${name} must be a percentage (e.g. 5%), a size (e.g. 100MiB) or "unlimited"`,
    );
  }
  return v.replace(/\s+/g, "");
}

const logger = getLogger("server:project-backup:repo-prune-plan");
const LOCK_KEY = "project-backup-repo-prune-plan";

let running = false;

// One plan at a time on a bay, also across API replicas: a session advisory
// lock held on a dedicated connection for the whole run.
async function withPrunePlanLock<T>(fn: () => Promise<T>): Promise<T> {
  const busy = () =>
    new Error(
      "a prune plan is already running on this bay; try again when it finishes",
    );
  if (running) throw busy();
  running = true;
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await getPool().connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [LOCK_KEY],
    );
    locked = rows[0]?.locked === true;
    if (!locked) throw busy();
    return await fn();
  } finally {
    if (client) {
      if (locked) {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY])
          .catch((err) =>
            logger.warn("unable to release the prune plan lock", {
              err: `${err}`,
            }),
          );
      }
      client.release();
    }
    running = false;
  }
}

export async function getProjectBackupRepoPrunePlan({
  repo_id,
  max_unused,
  max_repack,
  repoinfo = false,
  timeout_ms,
  deps = {},
}: {
  repo_id: string;
  max_unused?: string | null;
  max_repack?: string | null;
  repoinfo?: boolean;
  timeout_ms?: number;
  deps?: ProbeDeps;
}): Promise<ProjectBackupRepoPrunePlan> {
  if (!isValidUUID(repo_id)) throw new Error("repo_id must be a valid uuid");
  const options = {
    max_unused: validatePruneLimit("max_unused", max_unused),
    max_repack: validatePruneLimit("max_repack", max_repack),
  };
  const timeout =
    deps.timeoutMs ??
    Math.min(
      PRUNE_PLAN_MAX_TIMEOUT_MS,
      Math.max(60_000, Number(timeout_ms) || PRUNE_PLAN_DEFAULT_TIMEOUT_MS),
    );
  await ensureProjectBackupRepoSchema();
  const { rows } = await getPool().query<{
    id: string;
    region: string | null;
    status: string | null;
    root: string | null;
    bucket_name: string | null;
  }>(
    `SELECT r.id, r.region, r.status, r.root, b.name AS bucket_name
       FROM project_backup_repos r
       LEFT JOIN buckets b ON b.id = r.bucket_id
      WHERE r.id = $1`,
    [repo_id],
  );
  const repo = rows[0];
  if (!repo) throw new Error(`no shared project backup repository ${repo_id}`);
  return await withPrunePlanLock(async () => {
    const toml = deps.loadToml
      ? await deps.loadToml(repo_id)
      : (await getProjectBackupConfigForRepo({ backup_repo_id: repo_id })).toml;
    if (!toml.trim()) {
      throw new Error(
        "the repository has no usable configuration (missing bucket, root or storage credentials)",
      );
    }
    const secrets = profileSecrets(toml);
    const rusticPath = deps.rusticPath ?? defaultRusticPath;
    const niced = existsSync(NICE) && !deps.rusticPath;
    const runRustic = async (args: string[], timeout: number, home: string) =>
      await exec({
        cmd: niced ? NICE : rusticPath,
        prefixArgs: niced ? ["-n", "15", rusticPath] : [],
        safety: args,
        timeout,
        maxSize: PRUNE_PLAN_MAX_OUTPUT_BYTES,
        env: { HOME: home },
      });
    const started = new Date();
    // One budget for the whole run: prune, then repoinfo with what is left.
    const deadline = started.getTime() + timeout;
    const run = await withRepoProfile(
      { repo_id, toml, deps, prefix: PRUNE_PLAN_PROFILE_PREFIX },
      async (profile, tempDir) => {
        const common = ["-P", profile, "--no-cache", "--no-progress"];
        const pruneArgs = [...common, "--dry-run", "prune"];
        if (options.max_unused) {
          pruneArgs.push("--max-unused", options.max_unused);
        }
        if (options.max_repack) {
          pruneArgs.push("--max-repack", options.max_repack);
        }
        const output = await runRustic(
          pruneArgs,
          Math.max(1, deadline - Date.now()),
          tempDir,
        );
        const stderr = Buffer.from(output.stderr).toString();
        if (output.code !== 0 || output.truncated) {
          throw new Error(
            output.truncated && output.code !== 0
              ? `rustic prune --dry-run did not finish within ${Math.round(timeout / 1000)}s`
              : summarizeRusticError(stderr, secrets) ||
                  `rustic exited with code ${output.code}`,
          );
        }
        const parsed = parseRusticPruneStats(stderr);
        if (!parsed.stats.total_prune) {
          throw new Error(
            "rustic prune --dry-run printed no statistics (unexpected output format)",
          );
        }
        let info: unknown;
        let infoError: string | undefined;
        const left = deadline - Date.now();
        if (repoinfo && left < REPOINFO_MIN_BUDGET_MS) {
          infoError = `not run: the prune used up the ${Math.round(timeout / 1000)}s time budget`;
        } else if (repoinfo) {
          const out = await runRustic(
            [...common, "repoinfo", "--json", "--only-index"],
            Math.min(REPOINFO_TIMEOUT_MS, left),
            tempDir,
          );
          if (out.code === 0 && !out.truncated) {
            try {
              info = JSON.parse(Buffer.from(out.stdout).toString());
            } catch (err) {
              infoError = `unable to parse rustic repoinfo output: ${err}`;
            }
          } else {
            infoError =
              summarizeRusticError(
                Buffer.from(out.stderr).toString(),
                secrets,
              ) || `rustic repoinfo exited with code ${out.code}`;
          }
        }
        return { parsed, info, infoError };
      },
    );
    if (run.cleanupError != null) throw new Error(run.cleanupError);
    if (run.error !== undefined) {
      throw new Error(summarizeRusticError(`${run.error}`, secrets));
    }
    const { parsed, info, infoError } = run.value!;
    return {
      repo_id,
      region: repo.region,
      status: repo.status,
      bucket_name: repo.bucket_name,
      root: repo.root,
      dry_run: true,
      options,
      started_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
      stats: parsed.stats,
      estimate: estimatePruneCost(parsed.stats, info),
      ...(repoinfo ? { repoinfo: info ?? null } : {}),
      ...(infoError ? { repoinfo_error: infoError } : {}),
      lines: parsed.lines,
    };
  });
}

// Run a plan here and record it, success or failure, in the central log.
// The caller has checked that the actor is an admin with a recent second
// factor (on this bay, or on source_bay_id for a request it forwarded).
export async function runAuditedProjectBackupRepoPrunePlan({
  actor_account_id,
  source_bay_id,
  bay_id,
  repo_id,
  max_unused,
  max_repack,
  repoinfo,
  timeout_ms,
  deps,
}: {
  actor_account_id: string;
  source_bay_id: string;
  bay_id: string;
  repo_id: string;
  max_unused?: string | null;
  max_repack?: string | null;
  repoinfo?: boolean;
  timeout_ms?: number;
  deps?: ProbeDeps;
}): Promise<ProjectBackupRepoPrunePlan> {
  const request = {
    repo_id,
    max_unused: max_unused ?? null,
    max_repack: max_repack ?? null,
    repoinfo: repoinfo === true,
    timeout_ms: timeout_ms ?? null,
  };
  const audit = async (value: Record<string, unknown>) =>
    await centralLog({
      event: "project_backup_repo_prune_plan",
      value: {
        account_id: actor_account_id,
        bay_id,
        source_bay_id,
        ...request,
        ...value,
      },
    }).catch((err) =>
      logger.warn("unable to record a prune plan in the central log", {
        err: `${err}`,
      }),
    );
  try {
    const plan = await getProjectBackupRepoPrunePlan({
      repo_id,
      max_unused,
      max_repack,
      repoinfo: request.repoinfo,
      timeout_ms,
      deps,
    });
    await audit({
      ok: true,
      duration_ms: plan.duration_ms,
      total_prune_bytes: plan.stats.total_prune?.bytes ?? null,
      to_repack_bytes: plan.stats.to_repack?.bytes ?? null,
    });
    return plan;
  } catch (err) {
    await audit({ ok: false, error: `${err}`.slice(0, 500) });
    throw err;
  }
}
