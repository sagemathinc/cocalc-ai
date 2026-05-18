/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { expireTime } from "@cocalc/database/pool/util";
import { v4 as uuid } from "uuid";

export const SUPPORT_TICKET_ATTEMPT_TTL_DAYS = 8;

type Window = "10 minutes" | "1 hour" | "1 day";

interface Rule {
  key: string;
  interval: Window;
  limit: number;
  where: string;
  params: unknown[];
}

export class SupportTicketRateLimitError extends Error {
  code = "support_ticket_rate_limited";
}

export async function assertSupportTicketRateLimit({
  account_id,
  email,
  ip_address,
}: {
  account_id?: string;
  email: string;
  ip_address?: string;
}): Promise<void> {
  const pool = getPool();
  const attempt_id = uuid();
  const normalizedEmail = normalizeRateLimitEmail(email);
  const normalizedIp = normalizeRateLimitIp(ip_address);
  await pool.query(
    `INSERT INTO support_ticket_attempts
       (id, time, expire, ip_address, email_address, account_id, accepted, reason)
     VALUES ($1, NOW(), $2, $3, $4, $5, FALSE, $6)`,
    [
      attempt_id,
      expireTime(SUPPORT_TICKET_ATTEMPT_TTL_DAYS * 24 * 60 * 60),
      normalizedIp ?? null,
      normalizedEmail,
      account_id ?? null,
      "pending",
    ],
  );

  const blocked = await firstBlockedRule(
    buildRules({
      account_id,
      email: normalizedEmail,
      ip_address: normalizedIp,
    }),
  );
  if (blocked != null) {
    await markAttempt({
      attempt_id,
      accepted: false,
      reason: blocked,
    });
    throw new SupportTicketRateLimitError(
      "Too many support requests recently. Please wait and try again.",
    );
  }

  await markAttempt({ attempt_id, accepted: true });
}

function buildRules({
  account_id,
  email,
  ip_address,
}: {
  account_id?: string;
  email: string;
  ip_address?: string;
}): Rule[] {
  const rules: Rule[] = [
    {
      key: "email_hour",
      interval: "1 hour",
      limit: 3,
      where: "email_address=$1",
      params: [email],
    },
    {
      key: "email_day",
      interval: "1 day",
      limit: 6,
      where: "email_address=$1",
      params: [email],
    },
  ];

  if (ip_address) {
    rules.push(
      {
        key: "ip_hour",
        interval: "1 hour",
        limit: account_id ? 20 : 10,
        where: "ip_address=$1::inet",
        params: [ip_address],
      },
      {
        key: "ip_day",
        interval: "1 day",
        limit: account_id ? 60 : 30,
        where: "ip_address=$1::inet",
        params: [ip_address],
      },
      {
        key: "email_ip_10m",
        interval: "10 minutes",
        limit: 2,
        where: "email_address=$1 AND ip_address=$2::inet",
        params: [email, ip_address],
      },
      {
        key: "email_ip_hour",
        interval: "1 hour",
        limit: 4,
        where: "email_address=$1 AND ip_address=$2::inet",
        params: [email, ip_address],
      },
    );
  }

  if (account_id) {
    rules.push(
      {
        key: "account_hour",
        interval: "1 hour",
        limit: 5,
        where: "account_id=$1::uuid",
        params: [account_id],
      },
      {
        key: "account_day",
        interval: "1 day",
        limit: 20,
        where: "account_id=$1::uuid",
        params: [account_id],
      },
    );
  }

  return rules;
}

async function firstBlockedRule(rules: Rule[]): Promise<string | undefined> {
  for (const rule of rules) {
    const count = await countRecent(rule);
    if (count > rule.limit) {
      return rule.key;
    }
  }
}

async function countRecent(rule: Rule): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS count
       FROM support_ticket_attempts
      WHERE time >= NOW() - INTERVAL '${rule.interval}'
        AND ${rule.where}`,
    rule.params,
  );
  return Number(rows[0]?.count ?? 0);
}

async function markAttempt({
  attempt_id,
  accepted,
  reason,
}: {
  attempt_id: string;
  accepted: boolean;
  reason?: string;
}): Promise<void> {
  await getPool().query(
    "UPDATE support_ticket_attempts SET accepted=$2, reason=$3 WHERE id=$1",
    [attempt_id, accepted, reason ?? null],
  );
}

function normalizeRateLimitEmail(email: string): string {
  return `${email ?? ""}`.trim().toLowerCase();
}

function normalizeRateLimitIp(ip_address?: string): string | undefined {
  const value = `${ip_address ?? ""}`.trim();
  return value || undefined;
}
