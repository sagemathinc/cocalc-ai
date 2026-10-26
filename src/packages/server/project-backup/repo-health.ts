/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Periodic health probe of the shared project-backup repositories.

In 2026-08 two shared repositories were unreadable from the moment they were
created (an initialization race), and nothing noticed for two months: 147
deleted-project backup purges sat quarantined on them. This probe checks, about
once a day, that each repository still in use (active, sealed or draining)
opens with its stored secret: it runs `rustic cat config`, which reads the
repository's key and config files and changes nothing. It never runs `init`
or anything else that writes to a repository.

Each result is recorded in project_backup_repo_probes. Admin health and
`cocalc admin backup-shards` show them, and admins get an alert when a
repository fails or the probes stop running:

- critical: a repository fails for a reason retrying will not fix (wrong
  password, missing config, no usable configuration), fails twice in a row,
  or has not been probed for two days;
- warning: a single failure that may be transient (timeout, network error);
- healthy: otherwise.
*/

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getLogger from "@cocalc/backend/logger";
import exec from "@cocalc/backend/sandbox/exec";
import { rustic as defaultRusticPath } from "@cocalc/backend/sandbox/install";
import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";
import {
  ensureProjectBackupRepoSchema,
  getProjectBackupConfigForRepo,
  projectBackupReposAreSeedManaged,
} from "./index";
import {
  DETERMINISTIC_PROBE_ERROR_KINDS,
  ensureProjectBackupRepoProbeSchema,
  recordProjectBackupRepoProbe,
  type ProjectBackupRepoProbeErrorKind,
  type ProjectBackupRepoProbeResult,
} from "./repo-probe-status";

const logger = getLogger("server:project-backup:repo-health");

// Repository statuses whose data is still needed (backups, restores, purges).
export const PROBED_REPO_STATUSES = ["active", "sealed", "draining"];
export const PROBE_INTERVAL_MS = 23 * 60 * 60 * 1000;
// A failed repository is probed again sooner, to confirm or clear it.
export const FAILED_REPROBE_INTERVAL_MS = 60 * 60 * 1000;
export const PROBE_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_CONCURRENCY = 2;
const PROBE_MAX_PER_RUN = 24;
const PROBE_STAGGER_MS = 2_000;
const MAX_ERROR_LENGTH = 300;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;
const ALERT_SUBJECT = "Project backup repository health probe failing";

export interface ProjectBackupRepoProbeOutcome {
  result: ProjectBackupRepoProbeResult;
  error_kind?: ProjectBackupRepoProbeErrorKind;
  error?: string;
  duration_ms: number;
}

export interface ProbeDeps {
  // The repository's rustic TOML profile (password and bucket credentials
  // included), or "" if it has no usable configuration.
  loadToml?: (repo_id: string) => Promise<string>;
  rusticPath?: string;
  timeoutMs?: number;
  staggerMs?: number;
  now?: () => Date;
  // For tests: where the temporary profile goes, and how it is removed.
  tempRoot?: string;
  removeTempDir?: (dir: string) => Promise<void>;
}

async function defaultLoadToml(repo_id: string): Promise<string> {
  return (await getProjectBackupConfigForRepo({ backup_repo_id: repo_id }))
    .toml;
}

// Values from the profile that must never reach a log, a table or an alert.
function profileSecrets(toml: string): string[] {
  const secrets: string[] = [];
  for (const line of toml.split("\n")) {
    const m = line.match(
      /^\s*(password|access_key_id|secret_access_key)\s*=\s*"(.*)"\s*$/,
    );
    if (m?.[2]) secrets.push(m[2]);
  }
  return secrets;
}

// The first line of rustic's "Message:", without terminal colors or any
// profile secret, and bounded in length.
export function summarizeRusticError(
  stderr: string,
  secrets: string[],
): string {
  const lines = stderr
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const messageAt = lines.findIndex((line) => line === "Message:");
  let text =
    (messageAt >= 0 ? lines[messageAt + 1] : undefined) ??
    lines.find((line) => /error/i.test(line)) ??
    lines.at(-1) ??
    "";
  for (const secret of secrets) {
    text = text.split(secret).join("***");
  }
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...`
    : text;
}

export function classifyRusticError(
  stderr: string,
): ProjectBackupRepoProbeErrorKind {
  if (
    /\bC002\b/.test(stderr) ||
    /password .*(incorrect|wrong)|no suitable key/i.test(stderr)
  ) {
    return "wrong_password";
  }
  if (/no repository config file found/i.test(stderr)) {
    return "missing_config";
  }
  return "error";
}

// Check that the repository's config opens with its stored secret. Read-only.
export async function probeProjectBackupRepo(
  repo_id: string,
  deps: ProbeDeps = {},
): Promise<ProjectBackupRepoProbeOutcome> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  let toml: string;
  try {
    toml = await (deps.loadToml ?? defaultLoadToml)(repo_id);
  } catch (err) {
    // The database, site settings or site key may be briefly unreadable, so
    // this is not (yet) a statement about the repository.
    return {
      result: "failed",
      error_kind: "error",
      error: `unable to load the repository configuration: ${`${err}`.slice(0, MAX_ERROR_LENGTH)}`,
      duration_ms: elapsed(),
    };
  }
  if (!toml.trim()) {
    return {
      result: "failed",
      error_kind: "no_config",
      error:
        "no usable configuration (missing bucket, root or storage credentials)",
      duration_ms: elapsed(),
    };
  }
  const secrets = profileSecrets(toml);
  let tempDir: string | undefined;
  let outcome: ProjectBackupRepoProbeOutcome;
  try {
    tempDir = await mkdtemp(
      join(deps.tempRoot ?? tmpdir(), "cocalc-backup-repo-probe-"),
    );
    outcome = await runRusticProbe({ tempDir, toml, secrets, deps });
    outcome.duration_ms = elapsed();
  } catch (err) {
    outcome = {
      result: "failed",
      error_kind: "error",
      error: summarizeRusticError(`${err}`, secrets),
      duration_ms: elapsed(),
    };
  }
  if (tempDir) {
    try {
      await (
        deps.removeTempDir ??
        ((dir) => rm(dir, { recursive: true, force: true }))
      )(tempDir);
    } catch (err) {
      // The profile holds the repository password and storage keys: make
      // the leftover visible instead of reporting a clean probe.
      logger.error("unable to remove a backup repository probe profile", {
        repo_id,
        path: tempDir,
        err: `${err}`,
      });
      outcome = {
        result: "failed",
        error_kind: "cleanup_failed",
        error: `unable to remove the temporary probe profile ${tempDir}, which holds the repository credentials; delete it: ${`${err}`.slice(0, 200)}`,
        duration_ms: elapsed(),
      };
    }
  }
  return outcome;
}

async function runRusticProbe({
  tempDir,
  toml,
  secrets,
  deps,
}: {
  tempDir: string;
  toml: string;
  secrets: string[];
  deps: ProbeDeps;
}): Promise<ProjectBackupRepoProbeOutcome> {
  const profile = join(tempDir, "repo");
  await writeFile(`${profile}.toml`, toml, { mode: 0o600 });
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const output = await exec({
    cmd: deps.rusticPath ?? defaultRusticPath,
    safety: ["-P", profile, "--no-cache", "cat", "config"],
    timeout: timeoutMs,
    maxSize: PROBE_MAX_OUTPUT_BYTES,
    env: { HOME: tempDir },
  });
  if (output.code === 0 && !output.truncated) {
    return { result: "ok", duration_ms: 0 };
  }
  if (output.truncated && output.code !== 0) {
    return {
      result: "failed",
      error_kind: "timeout",
      error: `rustic did not finish within ${Math.round(timeoutMs / 1000)}s`,
      duration_ms: 0,
    };
  }
  const stderr = Buffer.from(output.stderr).toString();
  return {
    result: "failed",
    error_kind: classifyRusticError(stderr),
    error:
      summarizeRusticError(stderr, secrets) ||
      `rustic exited with code ${output.code}`,
    duration_ms: 0,
  };
}

const PROFILE_PREFIX = "cocalc-backup-repo-probe-";
// No probe takes this long, so an older profile directory is a leftover.
const LEFTOVER_PROFILE_AGE_MS = 10 * 60 * 1000;
const LEFTOVER_ALERT_SUBJECT =
  "Project backup repository probe left credentials on disk";

// Remove probe profiles that an earlier probe (maybe in a process that has
// since restarted) failed to remove. Admins get an alert naming any that
// still cannot be removed.
export async function removeLeftoverProbeProfiles(
  deps: ProbeDeps = {},
): Promise<{ removed: string[]; failed: string[] }> {
  const root = deps.tempRoot ?? tmpdir();
  const now = (deps.now ?? (() => new Date()))().getTime();
  const removed: string[] = [];
  const failed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { removed, failed };
  }
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(root, name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs < LEFTOVER_PROFILE_AGE_MS) continue;
      await (
        deps.removeTempDir ??
        ((dir) => rm(dir, { recursive: true, force: true }))
      )(path);
      removed.push(path);
    } catch (err) {
      logger.error(
        "unable to remove a leftover backup repository probe profile",
        {
          path,
          err: `${err}`,
        },
      );
      failed.push(path);
    }
  }
  if (removed.length) {
    logger.warn("removed leftover backup repository probe profiles", {
      removed,
    });
  }
  if (failed.length) {
    await adminAlert({
      subject: LEFTOVER_ALERT_SUBJECT,
      body: [
        "These temporary backup repository probe profiles hold repository passwords and storage keys, and could not be removed. Delete them on the bay:",
        "",
        ...failed.map((path) => `- ${path}`),
      ].join("\n"),
      dedupBySubject: true,
      dedupMinutes: 24 * 60,
    });
  }
  return { removed, failed };
}

// Repositories whose probe is due: never probed, last probed a day ago, or
// failing and last probed an hour ago. Oldest first.
async function dueRepoIds(now: Date, limit: number): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT r.id
       FROM project_backup_repos r
       LEFT JOIN project_backup_repo_probes p ON p.repo_id = r.id
      WHERE (r.status IS NULL OR r.status = ANY($1::TEXT[]))
        AND (p.last_probe_at IS NULL
             OR p.last_probe_at <= $2::TIMESTAMPTZ - make_interval(secs => $3)
             OR (p.last_result = 'failed'
                 AND p.last_probe_at <= $2::TIMESTAMPTZ - make_interval(secs => $4)))
      ORDER BY p.last_probe_at ASC NULLS FIRST, r.created ASC, r.id ASC
      LIMIT $5`,
    [
      PROBED_REPO_STATUSES,
      now,
      PROBE_INTERVAL_MS / 1000,
      FAILED_REPROBE_INTERVAL_MS / 1000,
      limit,
    ],
  );
  return rows.map((row) => row.id);
}

export async function runProjectBackupRepoProbes(
  deps: ProbeDeps & { limit?: number; concurrency?: number } = {},
): Promise<{ probed: number; failed: number }> {
  await ensureProjectBackupRepoSchema();
  await ensureProjectBackupRepoProbeSchema();
  await removeLeftoverProbeProfiles(deps);
  const now = deps.now ?? (() => new Date());
  const queue = await dueRepoIds(now(), deps.limit ?? PROBE_MAX_PER_RUN);
  const staggerMs = deps.staggerMs ?? PROBE_STAGGER_MS;
  let probed = 0;
  let failed = 0;
  const worker = async () => {
    for (let repo_id = queue.shift(); repo_id; repo_id = queue.shift()) {
      const outcome = await probeProjectBackupRepo(repo_id, deps);
      try {
        await recordProjectBackupRepoProbe({
          repo_id,
          probed_at: now(),
          result: outcome.result,
          error_kind: outcome.error_kind,
          error: outcome.error,
          duration_ms: outcome.duration_ms,
        });
      } catch (err) {
        // Keep probing the others; the unrecorded one stays due.
        logger.warn("unable to record a project backup repository probe", {
          repo_id,
          err: `${err}`,
        });
        continue;
      }
      probed += 1;
      if (outcome.result === "failed") {
        failed += 1;
        logger.warn("project backup repository probe failed", {
          repo_id,
          error_kind: outcome.error_kind,
          error: outcome.error,
        });
      }
      if (staggerMs > 0 && queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, deps.concurrency ?? PROBE_CONCURRENCY) },
      worker,
    ),
  );
  return { probed, failed };
}

export interface ProjectBackupRepoHealthProblem {
  repo_id: string;
  region: string | null;
  status: string | null;
  problem: "failing" | "stale";
  error_kind: ProjectBackupRepoProbeErrorKind | null;
  error: string | null;
  failing_since: string | null;
  consecutive_failures: number;
  last_probe_at: string | null;
  critical: boolean;
}

export interface ProjectBackupRepoHealth {
  repos: number;
  ok: number;
  never_probed: number;
  problems: ProjectBackupRepoHealthProblem[];
}

export type ProjectBackupRepoHealthLevel = "healthy" | "warning" | "critical";

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function getProjectBackupRepoHealth({
  now = new Date(),
}: { now?: Date } = {}): Promise<ProjectBackupRepoHealth> {
  await ensureProjectBackupRepoSchema();
  await ensureProjectBackupRepoProbeSchema();
  const { rows } = await getPool().query<{
    id: string;
    region: string | null;
    status: string | null;
    created: Date | null;
    last_probe_at: Date | null;
    last_result: ProjectBackupRepoProbeResult | null;
    last_error_kind: ProjectBackupRepoProbeErrorKind | null;
    last_error: string | null;
    failing_since: Date | null;
    consecutive_failures: number | null;
  }>(
    `SELECT r.id, r.region, r.status, r.created,
            p.last_probe_at, p.last_result, p.last_error_kind, p.last_error,
            p.failing_since, p.consecutive_failures
       FROM project_backup_repos r
       LEFT JOIN project_backup_repo_probes p ON p.repo_id = r.id
      WHERE r.status IS NULL OR r.status = ANY($1::TEXT[])
      ORDER BY r.region ASC NULLS LAST, r.created ASC, r.id ASC`,
    [PROBED_REPO_STATUSES],
  );
  const health: ProjectBackupRepoHealth = {
    repos: rows.length,
    ok: 0,
    never_probed: 0,
    problems: [],
  };
  const staleBefore = now.getTime() - PROBE_STALE_MS;
  for (const row of rows) {
    if (!row.last_probe_at) health.never_probed += 1;
    // A new repository has two days for its first probe.
    const lastSeen = row.last_probe_at ?? row.created;
    const stale = !lastSeen || new Date(lastSeen).getTime() < staleBefore;
    const failing = row.last_result === "failed";
    if (row.last_result === "ok" && !stale) health.ok += 1;
    if (!failing && !stale) continue;
    const consecutive = Number(row.consecutive_failures ?? 0) || 0;
    health.problems.push({
      repo_id: row.id,
      region: row.region,
      status: row.status,
      problem: failing ? "failing" : "stale",
      error_kind: failing ? row.last_error_kind : null,
      error: failing ? row.last_error : null,
      failing_since: failing ? iso(row.failing_since) : null,
      consecutive_failures: consecutive,
      last_probe_at: iso(row.last_probe_at),
      critical:
        stale ||
        consecutive >= 2 ||
        (row.last_error_kind != null &&
          DETERMINISTIC_PROBE_ERROR_KINDS.has(row.last_error_kind)),
    });
  }
  return health;
}

export function projectBackupRepoHealthLevel(
  health: ProjectBackupRepoHealth,
): ProjectBackupRepoHealthLevel {
  if (health.problems.some((problem) => problem.critical)) return "critical";
  if (health.problems.length > 0) return "warning";
  return "healthy";
}

export function projectBackupRepoHealthSummary(
  health: ProjectBackupRepoHealth,
): string {
  const failing = health.problems.filter((p) => p.problem === "failing");
  const stale = health.problems.filter((p) => p.problem === "stale");
  if (failing.length === 0 && stale.length === 0) {
    if (health.repos === 0) {
      return "No shared project backup repository to probe on this bay.";
    }
    if (health.never_probed === 0) {
      return `All ${health.repos} shared project backup repositories open with their stored secret.`;
    }
    return `${health.ok} of ${health.repos} shared project backup repositories open with their stored secret; ${health.never_probed} new ${health.never_probed === 1 ? "one has" : "ones have"} not been probed yet.`;
  }
  const parts: string[] = [];
  if (failing.length) {
    parts.push(
      `${failing.length} shared project backup ${failing.length === 1 ? "repository fails" : "repositories fail"} the health probe`,
    );
  }
  if (stale.length) {
    parts.push(
      `${stale.length} ${stale.length === 1 ? "has" : "have"} not been probed for over two days`,
    );
  }
  return `${parts.join(", and ")}; backups, restores and purges on ${health.problems.length === 1 ? "it" : "them"} may fail.`;
}

export function projectBackupRepoHealthDetails(
  health: ProjectBackupRepoHealth,
): string[] {
  return health.problems.map((problem) =>
    problem.problem === "failing"
      ? `${problem.repo_id} (${problem.region ?? "unknown region"}, ${problem.status ?? "active"}): ${problem.error_kind ?? "error"} since ${problem.failing_since ?? "unknown"}, ${problem.consecutive_failures} consecutive: ${problem.error ?? ""}`
      : `${problem.repo_id} (${problem.region ?? "unknown region"}, ${problem.status ?? "active"}): last probed ${problem.last_probe_at ?? "never"}`,
  );
}

async function alertIfUnhealthy(health: ProjectBackupRepoHealth) {
  if (projectBackupRepoHealthLevel(health) !== "critical") return;
  await adminAlert({
    subject: ALERT_SUBJECT,
    body: [
      projectBackupRepoHealthSummary(health),
      "",
      ...projectBackupRepoHealthDetails(health)
        .filter((_, i) => health.problems[i].critical)
        .map((line) => `- ${line}`),
      "",
      "See `cocalc admin backup-shards` and admin health (backup-repos).",
    ].join("\n"),
    dedupBySubject: true,
    dedupMinutes: 24 * 60,
  });
}

export async function runProjectBackupRepoHealthCheck(
  deps: ProbeDeps = {},
): Promise<void> {
  // In a multi-bay cluster the seed bay owns the repositories and probes them.
  if (projectBackupReposAreSeedManaged()) return;
  let runError: unknown;
  try {
    const result = await runProjectBackupRepoProbes(deps);
    if (result.probed > 0) {
      logger.info("project backup repository probes completed", result);
    }
  } catch (err) {
    runError = err;
  }
  // Even when probing itself fails, so that repositories going unprobed for
  // two days still reach admins.
  await alertIfUnhealthy(
    await getProjectBackupRepoHealth({
      now: (deps.now ?? (() => new Date()))(),
    }),
  );
  if (runError) throw runError;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startProjectBackupRepoHealthMaintenance(): void {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = true;
    void runProjectBackupRepoHealthCheck()
      .catch((err) =>
        logger.warn("project backup repository health check failed", {
          err: `${err}`,
        }),
      )
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  // Spread bay restarts' first probes over a few minutes.
  setTimeout(
    run,
    FIRST_CHECK_DELAY_MS + Math.floor(Math.random() * FIRST_CHECK_DELAY_MS),
  ).unref?.();
}
