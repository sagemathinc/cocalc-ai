/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { createNotificationEventGraph } from "@cocalc/database/postgres/notifications-core";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  getSingleBayInfo,
  resolveAccountHomeBay,
} from "@cocalc/server/bay-directory";
import siteUrl from "@cocalc/server/hub/site-url";
import { resolveRuntimeMembership } from "@cocalc/server/membership/runtime-resolution";
import {
  storageFundingAccountId,
  storageServiceClassFromMembership,
} from "@cocalc/server/membership/storage-service-class";
import {
  PAYING_BACKUP_OBJECTIVE_MS,
  PAYING_SNAPSHOT_OBJECTIVE_MS,
} from "@cocalc/util/consts/project-recovery";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { isValidUUID } from "@cocalc/util/misc";
import { v5 as uuidv5 } from "uuid";
import {
  ensureProjectMaintenanceStatusTable,
  getProjectRecoveryStatusLocal,
  projectRecoveryDueAt,
  snapshotScheduleRevision,
} from "./maintenance-status";

const logger = getLogger("server:projects:recovery-customer-warnings");
const CHECK_INTERVAL_MS = 5 * 60_000;
const PAGE_SIZE = 500;
const MAX_PROJECTS_PER_CHECK = 5000;
const NOTICE_EVENT_NAMESPACE = "56cde593-74c2-4a98-8cca-3b27e51b6d0e";
const SCAN_STALE_MS = 15 * 60_000;

type Kind = "snapshot" | "backup";
type Users = Record<string, { group?: string }>;
type Candidate = {
  project_id: string;
  last_changed: Date | null;
  last_backup: Date | null;
  snapshots: SnapshotSchedule | null;
  backups: SnapshotSchedule | null;
  snapshot_at: Date | null;
  reconciled_change_at: Date | null;
  reconciled_schedule_revision: string | null;
};
type CurrentProject = {
  usage_account_id: string | null;
  users: Users | null;
};

export type ProjectRecoveryCustomerWarningScanStatus = {
  bay_id: string;
  last_completed_at: Date;
  scanned: number;
  notices_sent: number;
  failures: number;
};

let ensureScanTablePromise: Promise<void> | undefined;

async function ensureScanTable(): Promise<void> {
  ensureScanTablePromise ??= getPool()
    .query(
      `CREATE TABLE IF NOT EXISTS project_recovery_customer_warning_scan_status (
      bay_id TEXT PRIMARY KEY,
      last_completed_at TIMESTAMPTZ NOT NULL,
      scanned INTEGER NOT NULL,
      notices_sent INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0
    )`,
    )
    .then(() =>
      getPool().query(
        `ALTER TABLE project_recovery_customer_warning_scan_status
         ADD COLUMN IF NOT EXISTS failures INTEGER NOT NULL DEFAULT 0`,
      ),
    )
    .then(() => undefined)
    .catch((err) => {
      ensureScanTablePromise = undefined;
      throw err;
    });
  await ensureScanTablePromise;
}

export async function getProjectRecoveryCustomerWarningScanStatus(
  bayId: string,
): Promise<ProjectRecoveryCustomerWarningScanStatus | null> {
  await ensureScanTable();
  const { rows } =
    await getPool().query<ProjectRecoveryCustomerWarningScanStatus>(
      `SELECT bay_id, last_completed_at, scanned, notices_sent, failures
       FROM project_recovery_customer_warning_scan_status WHERE bay_id=$1`,
      [bayId],
    );
  return rows[0] ?? null;
}

export function projectRecoveryCustomerWarningScanProblem({
  enabled,
  scan,
  checkedAt,
}: {
  enabled: boolean;
  scan: ProjectRecoveryCustomerWarningScanStatus | null;
  checkedAt: Date;
}): string | null {
  if (!enabled) return null;
  if (!scan) return "Customer warning scan has not completed";
  if (!Number.isFinite(scan.last_completed_at.getTime())) {
    return "Customer warning scan completion time is invalid";
  }
  if (checkedAt.getTime() - scan.last_completed_at.getTime() > SCAN_STALE_MS) {
    return `Customer warning scan stale since ${scan.last_completed_at.toISOString()}`;
  }
  if (scan.failures > 0) {
    return `Customer warning scan had ${scan.failures} classification or delivery failures`;
  }
  return null;
}

function warningDueTimes(row: Candidate, checkedAt: Date) {
  const snapshotReconciled =
    row.last_changed != null &&
    row.reconciled_change_at != null &&
    row.last_changed <= row.reconciled_change_at &&
    row.reconciled_schedule_revision ===
      snapshotScheduleRevision(row.snapshots);
  const snapshotDue =
    row.snapshots?.disabled === true || snapshotReconciled
      ? null
      : projectRecoveryDueAt(
          row.last_changed,
          row.snapshot_at,
          { ...DEFAULT_SNAPSHOT_COUNTS, ...row.snapshots },
          true,
        );
  const backupDue =
    row.backups?.disabled === true
      ? null
      : projectRecoveryDueAt(
          row.last_changed,
          row.last_backup,
          { ...DEFAULT_BACKUP_COUNTS, ...row.backups },
          false,
        );
  return [
    ["snapshot", snapshotDue, PAYING_SNAPSHOT_OBJECTIVE_MS],
    ["backup", backupDue, PAYING_BACKUP_OBJECTIVE_MS],
  ].flatMap(([kind, due, target]) =>
    due != null && checkedAt.getTime() - Date.parse(`${due}`) > Number(target)
      ? [{ kind: kind as Kind, due: `${due}` }]
      : [],
  );
}

async function notice({
  projectId,
  kind,
  due,
}: {
  projectId: string;
  kind: Kind;
  due: string;
}) {
  const target = kind === "snapshot" ? "30 minutes" : "6 hours";
  const copy = kind === "snapshot" ? "local snapshot" : "off-host backup";
  const recoveryUrl = await siteUrl(
    `projects/${encodeURIComponent(projectId)}/settings#recovery`,
  );
  return {
    subject: `Project recovery warning: ${kind}: ${projectId}: ${due}`,
    body: `A new ${copy} for project ${projectId} was due at ${due} and has not been confirmed within the paid-project target of ${target}. Recent changes may have less recovery coverage than expected. Review this project's Recovery settings for current status and any reported block:\n\n${recoveryUrl}\n\nThis notice does not mean that older recovery points are unavailable.`,
  };
}

async function deliverWarning({
  bayId,
  projectId,
  recipient,
  kind,
  due,
}: {
  bayId: string;
  projectId: string;
  recipient: string;
  kind: Kind;
  due: string;
}): Promise<boolean> {
  const eventId = uuidv5(
    `${projectId}:${kind}:${due}:${recipient}`,
    NOTICE_EVENT_NAMESPACE,
  );
  const existing = await getPool().query(
    "SELECT event_id FROM notification_events WHERE event_id=$1",
    [eventId],
  );
  if (existing.rows.length) return false;
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: recipient,
    user_account_id: recipient,
  });
  if (!home_bay_id) throw Error("recipient account home unavailable");
  const message = await notice({ projectId, kind, due });
  const action_link = `/projects/${projectId}/settings#recovery`;
  const summary = {
    title: message.subject,
    body_markdown: message.body,
    severity: "warning",
    notice_type: "project_recovery_warning",
    origin_label: "Project Recovery",
    action_link,
    action_label: "Review recovery status",
  };
  try {
    await createNotificationEventGraph({
      event_id: eventId,
      kind: "account_notice",
      source_bay_id: bayId,
      source_project_id: projectId,
      origin_kind: "project",
      payload_json: summary,
      targets: [
        {
          target_account_id: recipient,
          target_home_bay_id: home_bay_id,
          dedupe_key: `project-recovery-warning:${eventId}`,
          summary_json: summary,
        },
      ],
    });
    return true;
  } catch (err) {
    // A retiring primary worker can overlap its replacement. The event's
    // primary key makes this race harmless without dropping another failure.
    if ((err as { code?: string })?.code === "23505") {
      const { rows } = await getPool().query(
        "SELECT event_id FROM notification_events WHERE event_id=$1",
        [eventId],
      );
      if (rows.length) return false;
    }
    throw err;
  }
}

let cursor: string | null = null;
let timer: NodeJS.Timeout | undefined;
let running = false;

/** Scan only projects owned by this bay; account notices route to recipient home bays. */
export async function runProjectRecoveryCustomerWarningCheck({
  checkedAt = new Date(),
}: {
  checkedAt?: Date;
} = {}): Promise<{
  enabled: boolean;
  scanned: number;
  notices_sent: number;
  failures: number;
}> {
  const settings = await getServerSettings();
  if (settings.project_recovery_customer_warnings_enabled !== true) {
    return { enabled: false, scanned: 0, notices_sent: 0, failures: 0 };
  }
  await ensureProjectMaintenanceStatusTable();
  await ensureScanTable();
  const bayId = getSingleBayInfo().bay_id;
  let scanned = 0;
  let noticesSent = 0;
  let failures = 0;
  while (scanned < MAX_PROJECTS_PER_CHECK) {
    const { rows } = await getPool().query<Candidate>(
      `SELECT p.project_id, p.last_backup,
              COALESCE((to_jsonb(p)->>'last_changed')::TIMESTAMP, p.last_edited)
                AS last_changed,
              p.snapshots, p.backups, s.latest_snapshot_at AS snapshot_at,
              s.reconciled_change_at, s.reconciled_schedule_revision
         FROM projects p
         LEFT JOIN project_maintenance_status s ON s.project_id=p.project_id
           AND s.kind='snapshot' AND s.host_id=p.host_id
        WHERE p.provisioned IS TRUE AND p.deleted IS NOT TRUE
          AND p.host_id IS NOT NULL
          AND COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), $1)=$1
          AND ($2::uuid IS NULL OR p.project_id > $2::uuid)
        ORDER BY p.project_id LIMIT $3`,
      [bayId, cursor, Math.min(PAGE_SIZE, MAX_PROJECTS_PER_CHECK - scanned)],
    );
    if (!rows.length) {
      cursor = null;
      break;
    }
    for (const row of rows) {
      cursor = row.project_id;
      scanned++;
      const dueTimes = warningDueTimes(row, checkedAt);
      if (!dueTimes.length) continue;
      try {
        // Read current ownership and collaborators before choosing a payer or
        // recipients. A project can move bays or change collaborators mid-scan.
        const { rows: currentRows } = await getPool().query<CurrentProject>(
          `SELECT p.usage_account_id::text, p.users
             FROM projects p
            WHERE p.project_id=$1 AND p.provisioned IS TRUE
              AND p.deleted IS NOT TRUE AND p.host_id IS NOT NULL
              AND COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), $2)=$2`,
          [row.project_id, bayId],
        );
        const currentProject = currentRows[0];
        if (!currentProject) continue;
        const users = currentProject.users ?? {};
        const ownerId = Object.entries(users).find(
          ([, user]) => user?.group === "owner",
        )?.[0];
        const payer = storageFundingAccountId({
          owner_account_id: ownerId ?? null,
          usage_account_id: currentProject.usage_account_id,
          users,
        });
        if (!payer || !isValidUUID(payer)) continue;
        const membership = await resolveRuntimeMembership(payer);
        if (storageServiceClassFromMembership(membership) !== "paying") {
          continue;
        }
        // A successful report, edit, or schedule change may have arrived
        // during the scan. Re-evaluate the live status before delivery.
        const current = await getProjectRecoveryStatusLocal(row.project_id);
        const recipients = Object.entries(users)
          .filter(
            ([id, user]) =>
              isValidUUID(id) &&
              (user?.group === "owner" || user?.group === "collaborator"),
          )
          .map(([id]) => id);
        for (const { kind, due } of dueTimes) {
          const currentDue =
            kind === "snapshot"
              ? current.snapshot_due_at
              : current.backup_due_at;
          if (currentDue !== due) continue;
          for (const recipient of recipients) {
            try {
              if (
                await deliverWarning({
                  bayId,
                  projectId: row.project_id,
                  recipient,
                  kind,
                  due,
                })
              ) {
                noticesSent++;
              }
            } catch (err) {
              failures++;
              logger.warn("unable to deliver project recovery warning", {
                project_id: row.project_id,
                kind,
                recipient,
                err: `${err}`,
              });
            }
          }
        }
      } catch (err) {
        failures++;
        logger.warn("unable to classify project recovery warning", {
          project_id: row.project_id,
          err: `${err}`,
        });
      }
    }
    if (rows.length < PAGE_SIZE) {
      cursor = null;
      break;
    }
  }
  await getPool().query(
    `INSERT INTO project_recovery_customer_warning_scan_status
       (bay_id, last_completed_at, scanned, notices_sent, failures)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bay_id) DO UPDATE SET
       last_completed_at=excluded.last_completed_at,
       scanned=excluded.scanned,
       notices_sent=excluded.notices_sent,
       failures=excluded.failures`,
    [bayId, checkedAt, scanned, noticesSent, failures],
  );
  logger.info("project recovery customer warning scan completed", {
    bay_id: bayId,
    scanned,
    notices_sent: noticesSent,
    failures,
  });
  return { enabled: true, scanned, notices_sent: noticesSent, failures };
}

export function startProjectRecoveryCustomerWarningMaintenance(): void {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = true;
    void runProjectRecoveryCustomerWarningCheck()
      .catch((err) =>
        logger.warn("project recovery customer warning check failed", {
          err: `${err}`,
        }),
      )
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(run, 60_000).unref?.();
}
