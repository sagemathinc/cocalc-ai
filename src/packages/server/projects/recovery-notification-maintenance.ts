/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getProjectHostStoragePressureWindows } from "@cocalc/database/postgres/project-host-metrics";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getAdmins from "@cocalc/server/accounts/admins";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import sendMessage from "@cocalc/server/messages/send";
import {
  getProjectRecoveryHealth,
  getProjectRecoveryRecentPayingCompletions,
} from "./maintenance-status";
import { buildProjectRecoveryNotificationPlan } from "./recovery-notification-plan";

const logger = getLogger("server:projects:recovery-notifications");
const CHECK_INTERVAL_MS = 5 * 60_000;
const PRESSURE_FRESH_MS = 5 * 60_000;
const INCIDENT_DEDUP_MINUTES = 60;
const DAILY_DEDUP_MINUTES = 48 * 60;

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastDailyReportKey: string | undefined;

export async function runProjectRecoveryNotificationCheck({
  checkedAt = new Date(),
}: {
  checkedAt?: Date;
} = {}): Promise<{
  enabled: boolean;
  incident_count: number;
  daily_report_checked: boolean;
}> {
  const settings = await getServerSettings();
  if (settings.project_recovery_notifications_enabled !== true) {
    return { enabled: false, incident_count: 0, daily_report_checked: false };
  }

  const bayId = getSingleBayInfo().bay_id;
  const oncallId =
    `${settings.project_recovery_oncall_account_id ?? ""}`.trim();
  const admins = await getAdmins();
  if (!oncallId || !admins.includes(oncallId)) {
    if (!admins.length) {
      logger.error("project recovery notifications enabled without an admin", {
        bayId,
      });
      return { enabled: true, incident_count: 0, daily_report_checked: false };
    }
    await sendMessage({
      subject: `Admin Alert - Project recovery on-call configuration missing on ${bayId}`,
      body: `Project recovery notifications are enabled on owning bay ${bayId}, but the configured on-call account ID is empty or is not an administrator on this bay. Configure a local administrator recipient before relying on incident paging.`,
      to_ids: admins,
      dedupMinutes: DAILY_DEDUP_MINUTES,
      dedupBySubject: true,
      requireAccountNoticeDelivery: true,
    });
    return { enabled: true, incident_count: 0, daily_report_checked: false };
  }

  const [health, recentPayingCompletions, pressure] = await Promise.all([
    getProjectRecoveryHealth(),
    getProjectRecoveryRecentPayingCompletions(),
    getProjectHostStoragePressureWindows({ bay_id: bayId }),
  ] as const).catch(async (err) => {
    await sendMessage({
      subject: `Admin Alert - Project recovery observation unavailable on ${bayId}`,
      body: `The owning bay could not read project recovery status, recent attempts, or host pressure telemetry at ${checkedAt.toISOString()}. Investigate the health query before treating recovery status as healthy. Error: ${err}`,
      to_ids: [oncallId],
      dedupMinutes: INCIDENT_DEDUP_MINUTES,
      dedupBySubject: true,
      requireAccountNoticeDelivery: true,
    });
    throw err;
  });
  const missingPressureHosts = pressure
    .filter((host) => {
      const sampledAt = Date.parse(host.latest_valid_sample_at ?? "");
      return (
        !Number.isFinite(sampledAt) ||
        checkedAt.getTime() - sampledAt > PRESSURE_FRESH_MS
      );
    })
    .map((host) => host.host_name);
  const plan = buildProjectRecoveryNotificationPlan({
    bayId,
    checkedAt: checkedAt.toISOString(),
    health,
    recentPayingCompletions,
    missingPressureHosts,
  });

  for (const incident of plan.incidents) {
    await sendMessage({
      subject: `Admin Alert - ${incident.subject}`,
      body: incident.body,
      to_ids: [oncallId],
      dedupMinutes: INCIDENT_DEDUP_MINUTES,
      dedupBySubject: true,
      requireAccountNoticeDelivery: true,
    });
  }

  // The date in the subject makes one durable message per UTC day, including
  // after a worker restart. The message service suppresses duplicate sends.
  const date = checkedAt.toISOString().slice(0, 10);
  const dailyReportKey = `${date}:${oncallId}`;
  let dailyReportChecked = false;
  if (lastDailyReportKey !== dailyReportKey) {
    await sendMessage({
      to_ids: [oncallId],
      subject: `Project recovery daily debt report: ${bayId}: ${date}`,
      body: plan.dailyReport,
      dedupMinutes: DAILY_DEDUP_MINUTES,
      dedupBySubject: true,
      requireAccountNoticeDelivery: true,
    });
    lastDailyReportKey = dailyReportKey;
    dailyReportChecked = true;
  }
  return {
    enabled: true,
    incident_count: plan.incidents.length,
    daily_report_checked: dailyReportChecked,
  };
}

export function startProjectRecoveryNotificationMaintenance(): void {
  if (timer) return;
  const run = () => {
    if (running) return;
    running = true;
    void runProjectRecoveryNotificationCheck()
      .catch((err) =>
        logger.warn("project recovery notification check failed", {
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
