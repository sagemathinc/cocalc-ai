import getLogger from "@cocalc/backend/logger";
import { createHostStatusClient } from "@cocalc/conat/project-host/api";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotCounts,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { getMasterConatClient } from "./master-status";
import {
  runScheduledBackupMaintenance,
  runScheduledSnapshotMaintenance,
} from "./file-server";

const logger = getLogger("project-host:snapshot-backup-maintenance");

const DEFAULT_ACTIVE_DAYS = 2;
const DEFAULT_SWEEP_MS = 15 * 60 * 1000;
const DEFAULT_PARALLELISM = 4;

const inFlightProjects = new Set<string>();

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function mergeSchedule(
  defaults: SnapshotCounts,
  schedule: SnapshotSchedule | null | undefined,
): SnapshotSchedule {
  return {
    ...defaults,
    ...(schedule ?? {}),
  };
}

function scheduleToCounts(
  schedule: SnapshotSchedule,
  { allowFrequent = true }: { allowFrequent?: boolean } = {},
): SnapshotCounts {
  return {
    frequent: allowFrequent ? schedule.frequent : 0,
    daily: schedule.daily,
    weekly: schedule.weekly,
    monthly: schedule.monthly,
  };
}

async function runWithParallelism<T>(
  items: T[],
  parallelism: number,
  worker: (item: T) => Promise<void>,
) {
  let index = 0;
  const width = Math.max(1, parallelism);
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) {
          return;
        }
        await worker(items[current]);
      }
    }),
  );
}

export async function runProjectSnapshotBackupMaintenanceSweepOnce({
  hostId,
}: {
  hostId: string;
}) {
  const client = getMasterConatClient();
  if (!client) {
    logger.debug("skipping maintenance sweep without master conat client");
    return;
  }
  const statusClient = createHostStatusClient({
    client,
    timeout: 60_000,
  });
  const activeDays = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_MAINTENANCE_ACTIVE_DAYS,
    DEFAULT_ACTIVE_DAYS,
  );
  const parallelism = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_PARALLELISM,
    DEFAULT_PARALLELISM,
  );
  const rows = await statusClient.listProjectMaintenanceSchedules({
    host_id: hostId,
    active_days: activeDays,
  });
  if (!rows.length) {
    logger.debug("no active projects eligible for maintenance", { hostId });
    return;
  }
  await runWithParallelism(rows, parallelism, async (row) => {
    const project_id = `${row.project_id ?? ""}`.trim();
    if (!project_id) {
      return;
    }
    if (inFlightProjects.has(project_id)) {
      logger.debug("skipping overlapping maintenance sweep", { project_id });
      return;
    }
    inFlightProjects.add(project_id);
    try {
      const snapshotSchedule = mergeSchedule(
        DEFAULT_SNAPSHOT_COUNTS,
        row.snapshots,
      );
      if (!snapshotSchedule.disabled) {
        await runScheduledSnapshotMaintenance({
          project_id,
          counts: scheduleToCounts(snapshotSchedule),
        });
      }
      const backupSchedule = mergeSchedule(DEFAULT_BACKUP_COUNTS, row.backups);
      if (!backupSchedule.disabled) {
        await runScheduledBackupMaintenance({
          project_id,
          counts: scheduleToCounts(backupSchedule, { allowFrequent: false }),
        });
      }
    } catch (err) {
      logger.warn("snapshot/backup maintenance failed", {
        hostId,
        project_id,
        err: `${err}`,
      });
    } finally {
      inFlightProjects.delete(project_id);
    }
  });
}

export function startProjectSnapshotBackupMaintenance({
  hostId,
}: {
  hostId: string;
}) {
  const sweepMs = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS,
    DEFAULT_SWEEP_MS,
  );
  let closed = false;
  const runSweep = async () => {
    if (closed) {
      return;
    }
    try {
      await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId });
    } catch (err) {
      logger.warn("snapshot/backup maintenance sweep failed", {
        hostId,
        err: `${err}`,
      });
    }
  };
  void runSweep();
  const timer = setInterval(() => {
    void runSweep();
  }, sweepMs);
  timer.unref();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
