import { availableParallelism } from "node:os";
import getLogger from "@cocalc/backend/logger";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { hubApi } from "@cocalc/lite/hub/api";
import { getLocalHostId } from "./sqlite/hosts";

const logger = getLogger("project-host:backup-execution-limit");

function recommendedBackupParallelism(ncpus: number): number {
  if (!Number.isFinite(ncpus) || ncpus <= 0) {
    return 1;
  }
  return Math.min(32, Math.max(1, Math.floor(ncpus / 2)));
}

function envConfiguredBackupParallelism(): number | undefined {
  const raw =
    `${process.env.COCALC_PROJECT_HOST_BACKUP_MAX_PARALLEL ?? ""}`.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.max(1, Math.min(32, Math.floor(parsed)));
}

export const DEFAULT_BACKUP_MAX_PARALLEL =
  envConfiguredBackupParallelism() ??
  recommendedBackupParallelism(availableParallelism());

const CACHE_TTL_MS = 5_000;

export type BackupExecutionLimitState = {
  max_parallel: number;
  config_source: "env-legacy" | "db-override";
};

let state: BackupExecutionLimitState = {
  max_parallel: DEFAULT_BACKUP_MAX_PARALLEL,
  config_source: "env-legacy",
};
let expiresAt = 0;

async function fetchBackupExecutionLimit(): Promise<BackupExecutionLimitState> {
  const host_id = getLocalHostId();
  if (!host_id || !hubApi.system?.getProjectHostParallelOpsLimit) {
    return {
      max_parallel: DEFAULT_BACKUP_MAX_PARALLEL,
      config_source: "env-legacy",
    };
  }
  try {
    const resolved = await hubApi.system.getProjectHostParallelOpsLimit({
      host_id,
      worker_kind: "project-host-backup-execution",
    });
    return {
      max_parallel: Math.max(
        1,
        resolved.effective_limit ?? DEFAULT_BACKUP_MAX_PARALLEL,
      ),
      config_source:
        resolved.config_source === "db-override" ? "db-override" : "env-legacy",
    };
  } catch (err) {
    logger.debug("failed to refresh backup execution limit", {
      host_id,
      err: `${err}`,
    });
    return state;
  }
}

const refreshBackupExecutionLimit = reuseInFlight(async () => {
  const next = await fetchBackupExecutionLimit();
  state = next;
  expiresAt = Date.now() + CACHE_TTL_MS;
  return next;
});

export function getCachedBackupExecutionLimit(): BackupExecutionLimitState {
  return state;
}

export async function getBackupExecutionLimit({
  force = false,
}: {
  force?: boolean;
} = {}): Promise<BackupExecutionLimitState> {
  if (!force && expiresAt > Date.now()) {
    return state;
  }
  return await refreshBackupExecutionLimit();
}

export function resetBackupExecutionLimitForTest(): void {
  state = {
    max_parallel: DEFAULT_BACKUP_MAX_PARALLEL,
    config_source: "env-legacy",
  };
  expiresAt = 0;
}
