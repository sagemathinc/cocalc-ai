/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const logger = getLogger("server:messages:account-notice");

const DEFAULT_ORIGIN_LABEL = "Messages";

export async function mirrorSystemMessageToAccountNotice(opts: {
  from_id: string;
  to_ids: string[];
  subject: string;
  body: string;
  message_id: number;
}) {
  const target_account_ids = Array.from(
    new Set(
      (Array.isArray(opts.to_ids) ? opts.to_ids : []).filter(
        (account_id) => `${account_id ?? ""}`.trim() !== "",
      ),
    ),
  );
  if (target_account_ids.length === 0) {
    return;
  }
  const source_bay_id = getConfiguredBayId();
  const target_home_bays = await resolveNotificationTargetHomeBays({
    account_ids: target_account_ids,
    default_bay_id: source_bay_id,
  });
  await createNotificationEventGraph({
    kind: "account_notice",
    source_bay_id,
    source_project_id: null,
    actor_account_id: opts.from_id,
    origin_kind: "system",
    payload_json: {
      title: opts.subject,
      body_markdown: opts.body,
      severity: "info",
      origin_label: DEFAULT_ORIGIN_LABEL,
      message_id: opts.message_id,
    },
    targets: target_account_ids.map((target_account_id) => ({
      target_account_id,
      target_home_bay_id: target_home_bays[target_account_id],
      dedupe_key: `system-message:${opts.message_id}:${target_account_id}`,
      summary_json: {
        title: opts.subject,
        body_markdown: opts.body,
        severity: "info",
        origin_label: DEFAULT_ORIGIN_LABEL,
        message_id: opts.message_id,
      },
    })),
  });
}

export async function mirrorSystemMessageToAccountNoticeBestEffort(opts: {
  from_id: string;
  to_ids: string[];
  subject: string;
  body: string;
  message_id: number;
}) {
  try {
    await mirrorSystemMessageToAccountNotice(opts);
  } catch (err) {
    logger.warn("failed to mirror system message into account notices", {
      from_id: opts.from_id,
      to_ids: opts.to_ids,
      message_id: opts.message_id,
      err: `${err}`,
    });
  }
}
