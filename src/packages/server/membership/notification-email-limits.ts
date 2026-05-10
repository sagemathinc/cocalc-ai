/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveMembershipForAccount } from "./resolve";

export interface NotificationEmailSendLimitResult {
  allowed: boolean;
  notification_email_sent_5h: number;
  notification_email_sent_7d: number;
  notification_email_send_limit_5h?: number;
  notification_email_send_limit_7d?: number;
  blocked_by?: "5h" | "7d";
}

function countFromRow(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export async function checkNotificationEmailSendLimitForAccount(
  account_id: string,
): Promise<NotificationEmailSendLimitResult> {
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const { rows } = await getPool("short").query<{
    sent_5h: number | string;
    sent_7d: number | string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - interval '5 hours'
       )::INT AS sent_5h,
       COUNT(*) FILTER (
         WHERE created_at >= NOW() - interval '7 days'
       )::INT AS sent_7d
     FROM notification_email_outbox
     WHERE responsible_account_id = $1::UUID
       AND status IN ('sending', 'sent')`,
    [account_id],
  );
  const notification_email_sent_5h = countFromRow(rows[0]?.sent_5h);
  const notification_email_sent_7d = countFromRow(rows[0]?.sent_7d);
  const limit5h = limits.notification_email_send_limit_5h;
  const limit7d = limits.notification_email_send_limit_7d;
  if (limit5h != null && notification_email_sent_5h > limit5h) {
    return {
      allowed: false,
      notification_email_sent_5h,
      notification_email_sent_7d,
      notification_email_send_limit_5h: limit5h,
      notification_email_send_limit_7d: limit7d,
      blocked_by: "5h",
    };
  }
  if (limit7d != null && notification_email_sent_7d > limit7d) {
    return {
      allowed: false,
      notification_email_sent_5h,
      notification_email_sent_7d,
      notification_email_send_limit_5h: limit5h,
      notification_email_send_limit_7d: limit7d,
      blocked_by: "7d",
    };
  }
  return {
    allowed: true,
    notification_email_sent_5h,
    notification_email_sent_7d,
    notification_email_send_limit_5h: limit5h,
    notification_email_send_limit_7d: limit7d,
  };
}
