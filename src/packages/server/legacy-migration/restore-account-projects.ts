/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appendFile, readFile } from "node:fs/promises";

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";
import { getLro } from "@cocalc/server/lro/lro-db";
import {
  startProjectOnHost,
  stopProjectOnHost,
} from "@cocalc/server/project-host/control";
import type {
  LegacyMigrationProjectRestoreStatus,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";
import { isValidUUID } from "@cocalc/util/misc";
import { importProjects, listProjects, retryProjectRestore } from ".";

const DEFAULT_LIMIT = 2000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_RESTORE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const STOP_AFTER_START_ATTEMPTS = 3;
const STOP_AFTER_START_RETRY_MS = 5000;
const TERMINAL_LRO_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
const TERMINAL_RESTORE_STATUSES = new Set<LegacyMigrationProjectRestoreStatus>([
  "restored",
  "skipped",
  "failed",
  "selection-pending",
  "indexed",
]);

type Options = {
  accountId?: string;
  email?: string;
  legacyProjectIds: string[];
  idsFile?: string;
  hostId?: string;
  rootfsImage?: string;
  rootfsImageId?: string;
  region?: string;
  limit: number;
  query?: string;
  includeHidden: boolean;
  includeUnavailable: boolean;
  dryRun: boolean;
  startAfterRestore: boolean;
  stopAfterStart: boolean;
  retryFailedRestore: boolean;
  rerunSuccess: boolean;
  resumeFile?: string;
  pollMs: number;
  restoreTimeoutMs: number;
};

type ResumeStatus = "ok" | "failed" | "skipped";

type ResumeRecord = {
  ts: string;
  legacy_project_id: string;
  project_id?: string;
  status: ResumeStatus;
  phase: string;
  message?: string;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/restore-account-projects.js [options]

Focused operator script for importing/restoring all legacy projects for one
account, then optionally starting each restored project.

Options:
  --account-id <uuid>           Target cocalc.ai account id.
  --email <email>               Resolve target cocalc.ai account by email.
  --legacy-project-id <uuid>    Restore only this legacy project. Can repeat.
  --ids-file <path>             File of legacy project ids, one per line.
  --host-id <uuid>              Project host to use for newly-created imports.
  --rootfs-image-id <id>        Rootfs image id to use for newly-created imports.
  --rootfs-image <name>         Rootfs image name to use for newly-created imports.
  --region <region>             Region fallback for placement.
  --query <text>                Filter listed legacy projects by title/id.
  --limit <n>                   Maximum projects to list. Default: ${DEFAULT_LIMIT}.
  --include-hidden              Include hidden legacy projects.
  --include-unavailable         Include projects without available R2 archive rows.
                              They will be reported but cannot restore yet.
  --resume-file <path>          JSONL progress log. Successful rows are skipped
                              on rerun unless --rerun-success is set.
  --rerun-success               Do not skip successful rows from --resume-file.
  --no-start                    Do not start projects after restore succeeds.
  --stop-after-start            Start each restored project to verify it, then
                              stop it to avoid accumulating running projects.
  --no-retry-failed-restore     Do not retry already-imported failed restores.
  --poll-ms <n>                 Restore LRO polling interval. Default: ${DEFAULT_POLL_MS}.
  --restore-timeout-minutes <n> Restore wait timeout per project. Default: 720.
  --dry-run                     Print what would be done without changing state.
  --help                        Show this help.

Run this on the target account's home bay.
`);
  process.exit(0);
}

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    legacyProjectIds: [],
    limit: DEFAULT_LIMIT,
    includeHidden: false,
    includeUnavailable: false,
    dryRun: false,
    startAfterRestore: true,
    stopAfterStart: false,
    retryFailedRestore: true,
    rerunSuccess: false,
    pollMs: DEFAULT_POLL_MS,
    restoreTimeoutMs: DEFAULT_RESTORE_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--include-hidden") {
      options.includeHidden = true;
      continue;
    }
    if (arg === "--include-unavailable") {
      options.includeUnavailable = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-start") {
      options.startAfterRestore = false;
      continue;
    }
    if (arg === "--stop-after-start") {
      options.stopAfterStart = true;
      continue;
    }
    if (arg === "--no-retry-failed-restore") {
      options.retryFailedRestore = false;
      continue;
    }
    if (arg === "--rerun-success") {
      options.rerunSuccess = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--account-id") {
      options.accountId = value;
    } else if (arg === "--email") {
      options.email = value;
    } else if (arg === "--legacy-project-id") {
      options.legacyProjectIds.push(value);
    } else if (arg === "--ids-file") {
      options.idsFile = value;
    } else if (arg === "--host-id") {
      options.hostId = value;
    } else if (arg === "--rootfs-image") {
      options.rootfsImage = value;
    } else if (arg === "--rootfs-image-id") {
      options.rootfsImageId = value;
    } else if (arg === "--region") {
      options.region = value;
    } else if (arg === "--query") {
      options.query = value;
    } else if (arg === "--limit") {
      options.limit = positiveInt(value, arg);
    } else if (arg === "--poll-ms") {
      options.pollMs = positiveInt(value, arg);
    } else if (arg === "--restore-timeout-minutes") {
      options.restoreTimeoutMs = positiveInt(value, arg) * 60 * 1000;
    } else if (arg === "--resume-file") {
      options.resumeFile = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.accountId && !options.email) {
    throw new Error("one of --account-id or --email is required");
  }
  if (options.accountId && !isValidUUID(options.accountId)) {
    throw new Error("--account-id must be a valid uuid");
  }
  return options;
}

async function idsFromFile(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

async function resolveAccountId(options: Options): Promise<string> {
  if (options.accountId) return options.accountId;
  const email = clean(options.email);
  if (!email) throw new Error("--email must not be empty");
  const account = await getClusterAccountByEmail(email);
  if (!account?.account_id) {
    throw new Error(`account not found for email ${email}`);
  }
  const homeBayId = clean((account as any).home_bay_id);
  const currentBayId = getConfiguredBayId();
  if (homeBayId && homeBayId !== currentBayId) {
    throw new Error(
      `account ${account.account_id} is homed on ${homeBayId}; run this script on that bay, not ${currentBayId}`,
    );
  }
  return account.account_id;
}

function archiveAvailable(project: LegacyMigrationProjectSummary): boolean {
  return (
    project.artifact_status === "available" &&
    !!clean(project.artifact_key) &&
    typeof project.artifact_bytes === "number" &&
    Number.isFinite(project.artifact_bytes)
  );
}

async function readSuccessfulResumeIds(
  path: string | undefined,
): Promise<Set<string>> {
  const successful = new Set<string>();
  if (!path) return successful;
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return successful;
    throw err;
  }
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ResumeRecord;
      if (record.status === "ok" && record.legacy_project_id) {
        successful.add(record.legacy_project_id);
      }
    } catch {
      // Leave malformed operator notes alone; they just do not affect resume.
    }
  }
  return successful;
}

async function writeResumeRecord(
  path: string | undefined,
  record: Omit<ResumeRecord, "ts">,
): Promise<void> {
  const full: ResumeRecord = {
    ts: new Date().toISOString(),
    ...record,
  };
  const line = JSON.stringify(full);
  if (path) {
    await appendFile(path, `${line}\n`);
  }
  console.log(line);
}

async function waitForRestoreLro({
  opId,
  projectId,
  pollMs,
  timeoutMs,
}: {
  opId: string;
  projectId?: string;
  pollMs: number;
  timeoutMs: number;
}) {
  const started = Date.now();
  let lastProgressKey = "";
  while (Date.now() - started <= timeoutMs) {
    const lro = await getLro(opId);
    if (!lro) {
      throw new Error(`restore LRO ${opId} not found`);
    }
    const progress = lro.progress_summary ?? {};
    const progressKey = JSON.stringify({
      status: lro.status,
      progress,
      error: lro.error ?? null,
    });
    if (progressKey !== lastProgressKey) {
      lastProgressKey = progressKey;
      const percent =
        typeof progress.progress === "number" ? ` ${progress.progress}%` : "";
      const message = clean(progress.message) ?? clean(progress.phase) ?? "";
      console.log(
        [
          projectId ? `project=${projectId}` : undefined,
          `lro=${opId}`,
          `status=${lro.status}`,
          percent.trim() || undefined,
          message || undefined,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    if (TERMINAL_LRO_STATUSES.has(`${lro.status}`)) {
      if (lro.status !== "succeeded") {
        throw new Error(
          `restore LRO ${opId} ${lro.status}: ${lro.error ?? ""}`,
        );
      }
      return lro;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`restore LRO ${opId} timed out`);
}

async function latestProjectSummary({
  accountId,
  legacyProjectId,
}: {
  accountId: string;
  legacyProjectId: string;
}): Promise<LegacyMigrationProjectSummary | undefined> {
  const listed = await listProjects({
    account_id: accountId,
    include_hidden: true,
    query: legacyProjectId,
    limit: 5,
  });
  return listed.projects.find(
    (project) => project.legacy_project_id === legacyProjectId,
  );
}

async function stopProjectAfterVerification(projectId: string): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= STOP_AFTER_START_ATTEMPTS; i += 1) {
    try {
      await stopProjectOnHost(projectId);
      return;
    } catch (err) {
      lastError = err;
      if (i < STOP_AFTER_START_ATTEMPTS) {
        console.log(
          `stop ${projectId} attempt ${i} failed after successful start verification; retrying: ${err}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, STOP_AFTER_START_RETRY_MS),
        );
      }
    }
  }
  throw lastError;
}

async function restoreOne({
  accountId,
  project,
  options,
}: {
  accountId: string;
  project: LegacyMigrationProjectSummary;
  options: Options;
}): Promise<"ok" | "skipped"> {
  const legacyProjectId = project.legacy_project_id;
  if (!archiveAvailable(project)) {
    await writeResumeRecord(options.resumeFile, {
      legacy_project_id: legacyProjectId,
      project_id: project.project_id ?? undefined,
      status: "skipped",
      phase: "availability",
      message: "legacy project archive is not available yet",
    });
    return "skipped";
  }
  if (options.dryRun) {
    await writeResumeRecord(options.resumeFile, {
      legacy_project_id: legacyProjectId,
      project_id: project.project_id ?? undefined,
      status: "skipped",
      phase: "dry-run",
      message: "would import, restore, and start",
    });
    return "skipped";
  }

  let result = (
    await importProjects({
      account_id: accountId,
      legacy_project_ids: [legacyProjectId],
      restore_mode: "full",
      rootfs_image: clean(options.rootfsImage),
      rootfs_image_id: clean(options.rootfsImageId),
      host_id: clean(options.hostId),
      region: clean(options.region),
    })
  ).results[0];

  if (result.status === "failed") {
    throw new Error(result.error ?? "legacy project import failed");
  }
  if (
    options.retryFailedRestore &&
    result.project_id &&
    result.restore_status === "failed"
  ) {
    const retry = await retryProjectRestore({
      account_id: accountId,
      legacy_project_id: legacyProjectId,
    });
    result = {
      legacy_project_id: retry.legacy_project_id,
      project_id: retry.project_id,
      status: "joined",
      restore_status: retry.restore_status,
      restore_lro_op_id: retry.restore_lro_op_id,
    };
  }

  if (!result.project_id) {
    throw new Error("legacy project import returned no project_id");
  }
  if (result.restore_lro_op_id) {
    await waitForRestoreLro({
      opId: result.restore_lro_op_id,
      projectId: result.project_id,
      pollMs: options.pollMs,
      timeoutMs: options.restoreTimeoutMs,
    });
  }

  const refreshed = await latestProjectSummary({
    accountId,
    legacyProjectId,
  });
  const restoreStatus = refreshed?.restore_status ?? result.restore_status;
  if (restoreStatus && !TERMINAL_RESTORE_STATUSES.has(restoreStatus)) {
    throw new Error(`restore did not reach a terminal state: ${restoreStatus}`);
  }
  if (restoreStatus === "failed") {
    throw new Error(refreshed?.restore_error ?? "restore failed");
  }
  let phase = "restored";
  if (options.startAfterRestore) {
    await startProjectOnHost(result.project_id, { account_id: accountId });
    phase = "started";
    if (options.stopAfterStart) {
      try {
        await stopProjectAfterVerification(result.project_id);
        phase = "started-stopped";
      } catch (err) {
        phase = "started-stop-warning";
        await writeResumeRecord(options.resumeFile, {
          legacy_project_id: legacyProjectId,
          project_id: result.project_id,
          status: "ok",
          phase,
          message: `restore and start succeeded; stop cleanup failed after ${STOP_AFTER_START_ATTEMPTS} attempts: ${err}`,
        });
        return "ok";
      }
    }
  }
  await writeResumeRecord(options.resumeFile, {
    legacy_project_id: legacyProjectId,
    project_id: result.project_id,
    status: "ok",
    phase,
    message: restoreStatus ?? undefined,
  });
  return "ok";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  pool();
  const accountId = await resolveAccountId(options);
  const explicitIds = Array.from(
    new Set([
      ...options.legacyProjectIds.map((id) => id.trim()).filter(Boolean),
      ...(await idsFromFile(options.idsFile)),
    ]),
  );
  const listed = await listProjects({
    account_id: accountId,
    include_hidden: options.includeHidden,
    limit: options.limit,
    query: options.query,
  });
  const listedById = new Map(
    listed.projects.map((project) => [project.legacy_project_id, project]),
  );
  const projects =
    explicitIds.length > 0
      ? explicitIds.map((id) => {
          const project = listedById.get(id);
          if (!project) {
            throw new Error(`legacy project ${id} is not listed for account`);
          }
          return project;
        })
      : listed.projects;
  const successful = options.rerunSuccess
    ? new Set<string>()
    : await readSuccessfulResumeIds(options.resumeFile);
  console.log(
    [
      `account=${accountId}`,
      `listed=${listed.projects.length}`,
      `total=${listed.total_count}`,
      `selected=${projects.length}`,
      `resume_skip=${successful.size}`,
      options.dryRun ? "dry_run=true" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (listed.total_count > listed.projects.length && explicitIds.length === 0) {
    throw new Error(
      `listed ${listed.projects.length} of ${listed.total_count} projects; increase --limit before bulk restore`,
    );
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const project of projects) {
    const legacyProjectId = project.legacy_project_id;
    if (successful.has(legacyProjectId)) {
      skipped += 1;
      console.log(`skip ${legacyProjectId}: already successful in resume log`);
      continue;
    }
    if (!options.includeUnavailable && !archiveAvailable(project)) {
      skipped += 1;
      await writeResumeRecord(options.resumeFile, {
        legacy_project_id: legacyProjectId,
        project_id: project.project_id ?? undefined,
        status: "skipped",
        phase: "availability",
        message: "legacy project archive is not available yet",
      });
      continue;
    }
    try {
      console.log(`restore ${legacyProjectId}: ${project.title}`);
      const status = await restoreOne({ accountId, project, options });
      if (status === "ok") {
        ok += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      await writeResumeRecord(options.resumeFile, {
        legacy_project_id: legacyProjectId,
        project_id: project.project_id ?? undefined,
        status: "failed",
        phase: "error",
        message: `${err}`,
      });
    }
  }
  console.log(`done: ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
    process.exit(process.exitCode ?? 0);
  });
