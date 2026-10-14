/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project at its storage quota cannot take new local snapshots: Btrfs charges
the snapshot to the project, and raising the quota for it would let writes
exceed the quota (see the closed #1053). Scheduled snapshots then fail with
storage_quota_exceeded until the project is back under its quota. Tell the
project's owner and collaborators once per such episode, i.e. until a
snapshot succeeds again.
*/

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import siteUrl from "@cocalc/server/hub/site-url";
import { isValidUUID } from "@cocalc/util/misc";
import { ensureProjectMaintenanceStatusTable } from "./maintenance-status";
import { deliverProjectAccountNotice } from "./project-account-notice";

const logger = getLogger("server:projects:snapshot-quota-notice");

// One failure may race a cleanup that brings the project back under quota.
const MIN_CONSECUTIVE_FAILURES = 2;
const MAX_PROJECTS_PER_CHECK = 1000;
export const SNAPSHOT_QUOTA_NOTICE_TYPE = "project_snapshots_paused_quota";

type Row = {
  project_id: string;
  title: string | null;
  users: Record<string, { group?: string }> | null;
  latest_snapshot_at: Date | string | null;
};

export async function snapshotQuotaNotice(project_id: string) {
  const url = await siteUrl(
    `projects/${encodeURIComponent(project_id)}/settings#recovery`,
  );
  return {
    body: `New local snapshots of this project have stopped because the project is at its storage quota, so recent changes are not covered by a new snapshot. Existing snapshots remain available, subject to normal retention.\n\nTo resume, delete files you no longer need (space that older snapshots still hold is freed when those snapshots are deleted) or increase the project's storage. Snapshots resume automatically once the project is back under its quota.\n\n${url}\n\nYou will not get this notice again unless snapshots resume and then stop again.`,
  };
}

export async function runProjectSnapshotQuotaNoticeCheck(): Promise<{
  projects: number;
  notices_sent: number;
  failures: number;
}> {
  await ensureProjectMaintenanceStatusTable();
  const bayId = getSingleBayInfo().bay_id;
  const { rows } = await getPool().query<Row>(
    `SELECT p.project_id, p.title, p.users, s.latest_snapshot_at
       FROM project_maintenance_status s
       JOIN projects p ON p.project_id=s.project_id AND p.host_id=s.host_id
      WHERE s.kind='snapshot' AND s.outcome='failed'
        AND s.reason='storage_quota_exceeded'
        AND s.consecutive_failures >= $2
        AND p.provisioned IS TRUE AND p.deleted IS NOT TRUE
        AND COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), $1)=$1
        -- Already told in this episode: since the last successful snapshot,
        -- or in the last week when that is unknown (e.g. after a host move,
        -- which clears it). Notified projects also leave the page, so later
        -- projects are not starved.
        AND NOT EXISTS (
          SELECT 1 FROM notification_events e
           WHERE e.source_project_id=p.project_id
             AND e.payload_json->>'notice_type'=$4
             AND e.created_at >= COALESCE(
               s.latest_snapshot_at, NOW() - INTERVAL '7 days')
        )
      ORDER BY p.project_id
      LIMIT $3`,
    [
      bayId,
      MIN_CONSECUTIVE_FAILURES,
      MAX_PROJECTS_PER_CHECK,
      SNAPSHOT_QUOTA_NOTICE_TYPE,
    ],
  );
  let noticesSent = 0;
  let failures = 0;
  for (const row of rows) {
    const recipients = Object.entries(row.users ?? {})
      .filter(
        ([id, user]) =>
          isValidUUID(id) &&
          (user?.group === "owner" || user?.group === "collaborator"),
      )
      .map(([id]) => id);
    if (!recipients.length) continue;
    // A new episode starts after the next successful snapshot.
    const episode = row.latest_snapshot_at
      ? new Date(row.latest_snapshot_at).toISOString()
      : "never";
    const name = `${row.title ?? ""}`.trim() || row.project_id;
    try {
      const { body } = await snapshotQuotaNotice(row.project_id);
      for (const recipient of recipients) {
        try {
          if (
            await deliverProjectAccountNotice({
              bayId,
              projectId: row.project_id,
              recipient,
              eventKey: `${row.project_id}:snapshot-storage-quota:${episode}:${recipient}`,
              dedupePrefix: "project-snapshots-paused-quota",
              summary: {
                title: `Automatic snapshots paused: ${name}`,
                body_markdown: body,
                severity: "warning",
                notice_type: SNAPSHOT_QUOTA_NOTICE_TYPE,
                origin_label: "Project Recovery",
                action_link: `/projects/${row.project_id}/settings#recovery`,
                action_label: "Review storage and snapshots",
              },
            })
          ) {
            noticesSent++;
          }
        } catch (err) {
          failures++;
          logger.warn("unable to deliver snapshot quota notice", {
            project_id: row.project_id,
            recipient,
            err: `${err}`,
          });
        }
      }
    } catch (err) {
      failures++;
      logger.warn("unable to prepare snapshot quota notice", {
        project_id: row.project_id,
        err: `${err}`,
      });
    }
  }
  if (noticesSent || failures) {
    logger.info("snapshot quota notices", {
      bay_id: bayId,
      projects: rows.length,
      notices_sent: noticesSent,
      failures,
    });
  }
  return { projects: rows.length, notices_sent: noticesSent, failures };
}
