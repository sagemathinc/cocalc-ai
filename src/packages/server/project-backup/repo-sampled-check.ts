/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Quarterly sampled check of the sealed shared project-backup repositories.

A sealed repository takes no new backups, but restores and purges still need
its data. The monthly remote-only restore drills cover the active
repositories; for sealed (and draining) ones this check runs, about every 90
days per repository, a read-only and bounded `rustic check`:

- the whole repository's index is compared with the listing of its pack
  files, so a pack lost from the bucket (or deleted while still referenced)
  is found wherever it is;
- the trees of a few randomly chosen snapshots are checked, and a random
  subset (at most READ_DATA_SUBSET) of their pack data is downloaded,
  decrypted and hashed, which finds corrupt packs.

It never writes to a repository. It uses no local cache, checks one
repository per hourly run and runs under nice. Each rustic command has a
timeout: 10 minutes for the listing, an hour for a check (and an hour for the
one retry when a chosen snapshot was forgotten meanwhile).
Bucket egress from R2 is free; a check costs a few thousand read requests.

Each result is recorded in project_backup_repo_sampled_checks. Admin health
(project-recovery) shows a warning when a sealed repository's latest check
failed, or when it has not had a check for over 100 days (14 days for one
that has never been checked since it was sealed).
*/

import { existsSync } from "node:fs";

import getLogger from "@cocalc/backend/logger";
import exec from "@cocalc/backend/sandbox/exec";
import { rustic as defaultRusticPath } from "@cocalc/backend/sandbox/install";
import getPool from "@cocalc/database/pool";
import {
  ensureProjectBackupRepoSchema,
  getProjectBackupConfigForRepo,
  projectBackupReposAreSeedManaged,
} from "./index";
import {
  SAMPLED_CHECK_PROFILE_PREFIX,
  classifyRusticError,
  profileSecrets,
  summarizeRusticError,
  withRepoProfile,
  type ProbeDeps,
} from "./repo-health";

const logger = getLogger("server:project-backup:repo-sampled-check");

// Repository statuses that the restore drills do not cover but whose data is
// still needed.
export const SAMPLED_CHECK_REPO_STATUSES = ["sealed", "draining"];
export const SAMPLED_CHECK_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
// A failed check is repeated a day later, to confirm or clear it.
export const FAILED_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SAMPLED_CHECK_STALE_MS = 100 * 24 * 60 * 60 * 1000;
// A repository that was never checked since it was sealed.
export const SAMPLED_CHECK_FIRST_CHECK_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const SAMPLED_CHECK_SNAPSHOTS = 3;
export const READ_DATA_SUBSET = "1GiB";
const CHECK_TIMEOUT_MS = 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECK_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_LENGTH = 300;
const RUN_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const NICE = "/usr/bin/nice";

export type SampledCheckResult = "ok" | "failed";

// "damaged": rustic found errors (missing or corrupt packs, unreadable
// trees). The others are as for the health probe.
export type SampledCheckErrorKind =
  | "damaged"
  | "wrong_password"
  | "missing_config"
  | "no_config"
  | "cleanup_failed"
  | "timeout"
  | "error";

export interface SampledCheckOutcome {
  result: SampledCheckResult;
  error_kind?: SampledCheckErrorKind;
  error?: string;
  snapshots_checked: number;
  duration_ms: number;
}

let schemaReady: Promise<void> | undefined;

export async function ensureProjectBackupRepoSampledCheckSchema(): Promise<void> {
  schemaReady ??= getPool()
    .query(
      `CREATE TABLE IF NOT EXISTS project_backup_repo_sampled_checks (
        repo_id UUID PRIMARY KEY,
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_check_at TIMESTAMPTZ,
        last_result TEXT,
        last_error_kind TEXT,
        last_error TEXT,
        last_ok_at TIMESTAMPTZ,
        snapshots_checked INTEGER,
        read_data_subset TEXT,
        duration_ms INTEGER
      )`,
    )
    .then(() => undefined)
    .catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  await schemaReady;
}

// The first [ERROR] line rustic logged (it names the pack and the problem),
// how many there were, without terminal colors or any profile secret.
export function summarizeCheckErrors(
  stderr: string,
  secrets: string[],
): string {
  const errors = stderr
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[ERROR]"));
  if (!errors.length) return summarizeRusticError(stderr, secrets);
  let text = errors[0].replace(/^\[ERROR\]\s*/, "");
  for (const secret of secrets) {
    text = text.split(secret).join("***");
  }
  if (errors.length > 1) text = `${errors.length} errors; first: ${text}`;
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...`
    : text;
}

export function parseSnapshotIds(stdout: string): string[] {
  const ids = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(?:SnapshotId\()?([0-9a-f]{64})\)?$/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function sample<T>(items: T[], n: number, random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export interface SampledCheckDeps extends ProbeDeps {
  listTimeoutMs?: number;
  random?: () => number;
}

// Run the sampled check of one repository. Read-only.
export async function checkProjectBackupRepoSample(
  repo_id: string,
  deps: SampledCheckDeps = {},
): Promise<SampledCheckOutcome> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  let toml: string;
  try {
    toml = deps.loadToml
      ? await deps.loadToml(repo_id)
      : (await getProjectBackupConfigForRepo({ backup_repo_id: repo_id })).toml;
  } catch (err) {
    return {
      result: "failed",
      error_kind: "error",
      error: `unable to load the repository configuration: ${`${err}`.slice(0, MAX_ERROR_LENGTH)}`,
      snapshots_checked: 0,
      duration_ms: elapsed(),
    };
  }
  if (!toml.trim()) {
    return {
      result: "failed",
      error_kind: "no_config",
      error:
        "no usable configuration (missing bucket, root or storage credentials)",
      snapshots_checked: 0,
      duration_ms: elapsed(),
    };
  }
  const secrets = profileSecrets(toml);
  const rusticPath = deps.rusticPath ?? defaultRusticPath;
  const niced = existsSync(NICE) && !deps.rusticPath;
  const run = await withRepoProfile(
    { repo_id, toml, deps, prefix: SAMPLED_CHECK_PROFILE_PREFIX },
    async (profile, tempDir) => {
      const rustic = async (
        args: string[],
        timeout: number,
        maxSize: number,
      ) => {
        const started = Date.now();
        const output = await exec({
          cmd: niced ? NICE : rusticPath,
          prefixArgs: niced ? ["-n", "15", rusticPath] : [],
          safety: ["-P", profile, "--no-cache", "--no-progress", ...args],
          timeout,
          maxSize,
          env: { HOME: tempDir },
        });
        return {
          ...output,
          timedOut: output.truncated && Date.now() - started >= timeout,
          stderrText: Buffer.from(output.stderr).toString(),
        };
      };
      const failed = (
        output: Awaited<ReturnType<typeof rustic>>,
        timeout: number,
        damaged: boolean,
      ): Omit<SampledCheckOutcome, "duration_ms" | "snapshots_checked"> => {
        if (output.timedOut) {
          return {
            result: "failed",
            error_kind: "timeout",
            error: `rustic did not finish within ${Math.round(timeout / 1000)}s`,
          };
        }
        if (output.truncated) {
          return {
            result: "failed",
            error_kind: "error",
            error: "rustic wrote more output than expected",
          };
        }
        const kind = classifyRusticError(output.stderrText);
        return {
          result: "failed",
          error_kind:
            kind === "error" &&
            damaged &&
            /check found errors/i.test(output.stderrText)
              ? "damaged"
              : kind,
          error:
            summarizeCheckErrors(output.stderrText, secrets) ||
            `rustic exited with code ${output.code}`,
        };
      };

      const listTimeout = deps.listTimeoutMs ?? LIST_TIMEOUT_MS;
      const list = await rustic(
        ["list", "snapshots"],
        listTimeout,
        LIST_MAX_OUTPUT_BYTES,
      );
      if (list.code !== 0 || list.truncated) {
        return { ...failed(list, listTimeout, false), snapshots_checked: 0 };
      }
      const all = parseSnapshotIds(Buffer.from(list.stdout).toString());
      const checkTimeout = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
      const checkArgs = (ids: string[]) => [
        "check",
        "--read-data",
        "--read-data-subset",
        READ_DATA_SUBSET,
        ...ids,
      ];
      let ids = sample(
        all,
        SAMPLED_CHECK_SNAPSHOTS,
        deps.random ?? Math.random,
      );
      // An empty repository has no snapshot to choose: rustic then checks
      // just its index and pack files.
      let check = await rustic(
        checkArgs(ids),
        checkTimeout,
        CHECK_MAX_OUTPUT_BYTES,
      );
      // A purge may have forgotten a chosen snapshot since the listing:
      // choose again among the others, once.
      const forgotten = ids.filter((id) =>
        check.stderrText.includes(`snapshots/${id}`),
      );
      if (check.code !== 0 && !check.truncated && forgotten.length) {
        ids = sample(
          all.filter((id) => !forgotten.includes(id)),
          SAMPLED_CHECK_SNAPSHOTS,
          deps.random ?? Math.random,
        );
        if (!ids.length) {
          // Without snapshot ids rustic would check every snapshot.
          return {
            result: "failed" as const,
            error_kind: "error" as const,
            error: "the chosen snapshots were forgotten during the check",
            snapshots_checked: 0,
          };
        }
        check = await rustic(
          checkArgs(ids),
          checkTimeout,
          CHECK_MAX_OUTPUT_BYTES,
        );
      }
      if (check.code !== 0 || check.truncated) {
        return {
          ...failed(check, checkTimeout, true),
          snapshots_checked: ids.length,
        };
      }
      return { result: "ok" as const, snapshots_checked: ids.length };
    },
  );
  if (run.cleanupError != null) {
    return {
      result: "failed",
      error_kind: "cleanup_failed",
      error: run.cleanupError,
      snapshots_checked: run.value?.snapshots_checked ?? 0,
      duration_ms: elapsed(),
    };
  }
  if (run.error !== undefined) {
    return {
      result: "failed",
      error_kind: "error",
      error: summarizeRusticError(`${run.error}`, secrets),
      snapshots_checked: 0,
      duration_ms: elapsed(),
    };
  }
  return { ...run.value!, duration_ms: elapsed() };
}

async function recordSampledCheck(
  repo_id: string,
  checked_at: Date,
  outcome: SampledCheckOutcome,
): Promise<void> {
  const ok = outcome.result === "ok";
  await getPool().query(
    `UPDATE project_backup_repo_sampled_checks SET
       last_check_at = $2,
       last_result = $3,
       last_error_kind = $4,
       last_error = $5,
       last_ok_at = CASE WHEN $6 THEN $2::TIMESTAMPTZ ELSE last_ok_at END,
       snapshots_checked = $7,
       read_data_subset = $8,
       duration_ms = $9
     WHERE repo_id = $1`,
    [
      repo_id,
      checked_at,
      outcome.result,
      ok ? null : (outcome.error_kind ?? "error"),
      ok ? null : (outcome.error ?? null),
      ok,
      outcome.snapshots_checked,
      READ_DATA_SUBSET,
      outcome.duration_ms,
    ],
  );
}

// Note when each sealed repository was first seen, which starts its grace
// period for a first check; then return the one most overdue for a check.
async function nextDueRepoId(now: Date): Promise<string | undefined> {
  await getPool().query(
    `INSERT INTO project_backup_repo_sampled_checks (repo_id, first_seen_at)
     SELECT id, $2 FROM project_backup_repos WHERE status = ANY($1::TEXT[])
     ON CONFLICT (repo_id) DO NOTHING`,
    [SAMPLED_CHECK_REPO_STATUSES, now],
  );
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT r.id
       FROM project_backup_repos r
       JOIN project_backup_repo_sampled_checks c ON c.repo_id = r.id
      WHERE r.status = ANY($1::TEXT[])
        AND (c.last_check_at IS NULL
             OR c.last_check_at <= $2::TIMESTAMPTZ - make_interval(secs => $3)
             OR (c.last_result = 'failed'
                 AND c.last_check_at <= $2::TIMESTAMPTZ - make_interval(secs => $4)))
      ORDER BY c.last_check_at ASC NULLS FIRST, c.first_seen_at ASC, r.id ASC
      LIMIT 1`,
    [
      SAMPLED_CHECK_REPO_STATUSES,
      now,
      SAMPLED_CHECK_INTERVAL_MS / 1000,
      FAILED_RECHECK_INTERVAL_MS / 1000,
    ],
  );
  return rows[0]?.id;
}

// Check the repository most overdue for a sampled check, if any.
export async function runProjectBackupRepoSampledCheck(
  deps: SampledCheckDeps = {},
): Promise<{ repo_id: string; outcome: SampledCheckOutcome } | undefined> {
  // On an attached bay the seed bay owns and checks the repositories.
  if (projectBackupReposAreSeedManaged()) return;
  await ensureProjectBackupRepoSchema();
  await ensureProjectBackupRepoSampledCheckSchema();
  const now = deps.now ?? (() => new Date());
  const repo_id = await nextDueRepoId(now());
  if (!repo_id) return;
  const outcome = await checkProjectBackupRepoSample(repo_id, deps);
  await recordSampledCheck(repo_id, now(), outcome);
  if (outcome.result === "failed") {
    logger.warn("sampled check of a project backup repository failed", {
      repo_id,
      error_kind: outcome.error_kind,
      error: outcome.error,
    });
  } else {
    logger.info("sampled check of a project backup repository passed", {
      repo_id,
      snapshots_checked: outcome.snapshots_checked,
      duration_ms: outcome.duration_ms,
    });
  }
  return { repo_id, outcome };
}

export interface SampledCheckProblem {
  repo_id: string;
  region: string | null;
  status: string | null;
  problem: "failed" | "stale";
  error_kind: SampledCheckErrorKind | null;
  error: string | null;
  last_check_at: string | null;
  last_ok_at: string | null;
}

export interface SampledCheckHealth {
  // An attached bay: the seed bay checks the repositories.
  seed_managed: boolean;
  repos: number;
  current: number;
  // Never checked, still within the first-check grace period.
  pending: number;
  problems: SampledCheckProblem[];
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function getProjectBackupRepoSampledCheckHealth({
  now = new Date(),
  seed_managed = false,
}: {
  now?: Date;
  seed_managed?: boolean;
} = {}): Promise<SampledCheckHealth> {
  const health: SampledCheckHealth = {
    seed_managed,
    repos: 0,
    current: 0,
    pending: 0,
    problems: [],
  };
  if (seed_managed) return health;
  await ensureProjectBackupRepoSchema();
  await ensureProjectBackupRepoSampledCheckSchema();
  const { rows } = await getPool().query<{
    id: string;
    region: string | null;
    status: string | null;
    updated: Date | null;
    first_seen_at: Date | null;
    last_check_at: Date | null;
    last_result: SampledCheckResult | null;
    last_error_kind: SampledCheckErrorKind | null;
    last_error: string | null;
    last_ok_at: Date | null;
  }>(
    `SELECT r.id, r.region, r.status, r.updated,
            c.first_seen_at, c.last_check_at, c.last_result,
            c.last_error_kind, c.last_error, c.last_ok_at
       FROM project_backup_repos r
       LEFT JOIN project_backup_repo_sampled_checks c ON c.repo_id = r.id
      WHERE r.status = ANY($1::TEXT[])
      ORDER BY r.region ASC NULLS LAST, r.created ASC, r.id ASC`,
    [SAMPLED_CHECK_REPO_STATUSES],
  );
  health.repos = rows.length;
  for (const row of rows) {
    const problem = {
      repo_id: row.id,
      region: row.region,
      status: row.status,
      error_kind: null,
      error: null,
      last_check_at: iso(row.last_check_at),
      last_ok_at: iso(row.last_ok_at),
    };
    if (row.last_result === "failed") {
      health.problems.push({
        ...problem,
        problem: "failed",
        error_kind: row.last_error_kind,
        error: row.last_error,
      });
      continue;
    }
    if (row.last_check_at) {
      if (
        now.getTime() - new Date(row.last_check_at).getTime() >
        SAMPLED_CHECK_STALE_MS
      ) {
        health.problems.push({ ...problem, problem: "stale" });
      } else {
        health.current += 1;
      }
      continue;
    }
    // Never checked: from when the scheduler first saw it sealed (or, before
    // the scheduler first ran, when the repository last changed status).
    const since = row.first_seen_at ?? row.updated;
    if (
      !since ||
      now.getTime() - new Date(since).getTime() >
        SAMPLED_CHECK_FIRST_CHECK_GRACE_MS
    ) {
      health.problems.push({ ...problem, problem: "stale" });
    } else {
      health.pending += 1;
    }
  }
  return health;
}

export function projectBackupRepoSampledCheckLevel(
  health: SampledCheckHealth,
): "healthy" | "warning" {
  return health.problems.length > 0 ? "warning" : "healthy";
}

export function projectBackupRepoSampledCheckSummary(
  health: SampledCheckHealth,
): string {
  if (health.seed_managed) {
    return "The seed bay runs the sampled checks of sealed backup repositories.";
  }
  if (health.repos === 0) {
    return "No sealed backup repository to check.";
  }
  const failed = health.problems.filter((p) => p.problem === "failed").length;
  const stale = health.problems.length - failed;
  return `${health.current}/${health.repos} sealed backup repositories passed a sampled pack check within 100 days (${failed} latest failed, ${stale} overdue, ${health.pending} new awaiting a first check).`;
}

export function projectBackupRepoSampledCheckDetails(
  health: SampledCheckHealth,
): string[] {
  return health.problems.map((p) =>
    p.problem === "failed"
      ? `${p.repo_id} (${p.region ?? "unknown region"}, ${p.status}): sampled check failed at ${p.last_check_at ?? "unknown time"}: ${p.error_kind ?? "error"}: ${p.error ?? ""}`
      : `${p.repo_id} (${p.region ?? "unknown region"}, ${p.status}): no sampled check since ${p.last_check_at ?? "it was sealed"}`,
  );
}

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startProjectBackupRepoSampledCheckMaintenance(): void {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = true;
    void runProjectBackupRepoSampledCheck()
      .catch((err) =>
        logger.warn("sampled check of project backup repositories failed", {
          err: `${err}`,
        }),
      )
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref?.();
  setTimeout(
    run,
    FIRST_RUN_DELAY_MS + Math.floor(Math.random() * FIRST_RUN_DELAY_MS),
  ).unref?.();
}
