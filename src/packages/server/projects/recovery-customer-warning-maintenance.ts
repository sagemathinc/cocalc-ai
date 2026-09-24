/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import siteUrl from "@cocalc/server/hub/site-url";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  storageFundingAccountId,
  storageServiceClassFromMembership,
} from "@cocalc/server/membership/storage-service-class";
import sendMessage from "@cocalc/server/messages/send";
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
const NOTICE_DEDUP_MINUTES = 30 * 24 * 60;

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
  notices_checked: number;
}> {
  const settings = await getServerSettings();
  if (settings.project_recovery_customer_warnings_enabled !== true) {
    return { enabled: false, scanned: 0, notices_checked: 0 };
  }
  await ensureProjectMaintenanceStatusTable();
  const bayId = getSingleBayInfo().bay_id;
  let scanned = 0;
  let noticesChecked = 0;
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
        const membership = await resolveMembershipForAccount(payer);
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
          const message = await notice({
            projectId: row.project_id,
            kind,
            due,
          });
          for (const recipient of recipients) {
            try {
              await sendMessage({
                to_ids: [recipient],
                ...message,
                dedupMinutes: NOTICE_DEDUP_MINUTES,
                dedupBySubject: true,
                requireAccountNoticeDelivery: true,
              });
              noticesChecked++;
            } catch (err) {
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
  return { enabled: true, scanned, notices_checked: noticesChecked };
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
