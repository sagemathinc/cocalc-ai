/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Tell the person whose sensor it is when CoCalc pauses it (failures, lost
// access, a changed image...), so a broken sensor does not go unnoticed.

import getLogger from "@cocalc/backend/logger";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const logger = getLogger("agents:sensor-notify");

/** Titles and reasons can come from agent-written scripts: plain text only. */
function plain(text: string, max: number): string {
  const clipped = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return clipped
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\`*_[\]()<>#|~!]/g, "\\$&");
}

export async function notifySensorPaused({
  account_id,
  project_id,
  sensor_id,
  revision,
  title,
  reason,
}: {
  account_id: string;
  project_id: string;
  sensor_id: string;
  revision: number;
  title: string;
  reason: string;
}): Promise<void> {
  const source_bay_id = getConfiguredBayId();
  const homes = await resolveNotificationTargetHomeBays({
    account_ids: [account_id],
    default_bay_id: source_bay_id,
  });
  const summary = {
    title: `Sensor paused: ${plain(title, 100)}`,
    body_markdown: `${plain(reason, 600)}\n\nOpen the agent's **Sensors** dialog (the Connectors menu of its chat) to read the run log and resume it.`,
    severity: "warning",
    origin_label: "Agent sensors",
    notice_type: "agent_sensor_paused",
    action_label: "Open project",
    action_link: `/projects/${project_id}`,
  };
  await createNotificationEventGraph({
    kind: "account_notice",
    source_bay_id,
    source_project_id: project_id,
    actor_account_id: null,
    origin_kind: "system",
    payload_json: summary,
    targets: [
      {
        target_account_id: account_id,
        target_home_bay_id: homes[account_id],
        dedupe_key: `agent-sensor-paused:${sensor_id}:${revision}`,
        summary_json: summary,
      },
    ],
  });
}

/** Never fails the run that paused the sensor. */
export async function notifySensorPausedBestEffort(
  opts: Parameters<typeof notifySensorPaused>[0],
): Promise<void> {
  try {
    await notifySensorPaused(opts);
  } catch (err) {
    logger.warn("could not notify about a paused sensor", {
      sensor_id: opts.sensor_id,
      err: `${err}`,
    });
  }
}
