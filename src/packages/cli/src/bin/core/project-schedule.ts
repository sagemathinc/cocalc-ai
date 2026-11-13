// Automatic snapshot / backup schedules for `project snapshot schedule` and
// `project backup schedule`: the update built from the command's options,
// and the effective schedule (defaults filled in, as the project host and
// the schedule dialogs read it).

import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";

export type ScheduleKind = "snapshots" | "backups";

export interface ScheduleOptions {
  enabled?: boolean;
  disabled?: boolean;
  frequent?: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
}

const COUNT_FIELDS = ["frequent", "daily", "weekly", "monthly"] as const;

function parseCount(flag: string, value: string): number {
  const text = `${value}`.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`--${flag} must be a non-negative integer`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`--${flag} is too large`);
  }
  return n;
}

export function scheduleUpdateFromOptions(
  kind: ScheduleKind,
  opts: ScheduleOptions,
): Partial<SnapshotSchedule> {
  if (opts.enabled && opts.disabled) {
    throw new Error("use either --enabled or --disabled, not both");
  }
  const update: Partial<SnapshotSchedule> = {};
  if (opts.enabled) update.disabled = false;
  if (opts.disabled) update.disabled = true;
  for (const field of COUNT_FIELDS) {
    const value = opts[field];
    if (value == null) continue;
    if (kind === "backups" && field === "frequent") {
      throw new Error("backups have no frequent tier");
    }
    update[field] = parseCount(field, value);
  }
  if (Object.keys(update).length === 0) {
    throw new Error(
      `nothing to change: give --enabled, --disabled or a count (${
        kind === "snapshots" ? "--frequent, " : ""
      }--daily, --weekly, --monthly)`,
    );
  }
  return update;
}

export function effectiveSchedule(
  kind: ScheduleKind,
  stored: Partial<SnapshotSchedule> | null | undefined,
): SnapshotSchedule {
  const defaults =
    kind === "snapshots" ? DEFAULT_SNAPSHOT_COUNTS : DEFAULT_BACKUP_COUNTS;
  const schedule: SnapshotSchedule = {
    ...defaults,
    ...(stored ?? {}),
    disabled: stored?.disabled === true,
  };
  if (kind === "backups") schedule.frequent = 0;
  return schedule;
}

export function scheduleReport({
  project_id,
  kind,
  stored,
}: {
  project_id: string;
  kind: ScheduleKind;
  stored: Partial<SnapshotSchedule> | null | undefined;
}) {
  const schedule = effectiveSchedule(kind, stored);
  return {
    project_id,
    kind,
    enabled: !schedule.disabled,
    ...(kind === "snapshots" ? { frequent: schedule.frequent } : {}),
    daily: schedule.daily,
    weekly: schedule.weekly,
    monthly: schedule.monthly,
    // null: nothing stored, so the defaults apply
    stored: stored ?? null,
  };
}
