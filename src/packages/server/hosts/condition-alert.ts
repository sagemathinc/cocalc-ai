/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";

// A condition alert (a host condition that lasts) is sent once, then repeated
// as a reminder only after reminderMinutes while the condition is unchanged.
// Its body must list stable facts only, so the message dedupe on subject and
// body recognizes an unchanged condition. Once the condition clears, earlier
// alerts no longer count: a recurrence alerts at once.

export async function conditionAlert({
  subject,
  body,
  reminderMinutes,
}: {
  subject: string;
  body: string;
  reminderMinutes: number;
}): Promise<void> {
  const { rows } = await getPool().query<{ cleared_minutes: number | null }>(
    `INSERT INTO admin_alert_state(subject, active, updated_at)
     VALUES($1, true, now())
     ON CONFLICT(subject) DO UPDATE SET active=true, updated_at=now()
     RETURNING (EXTRACT(EPOCH FROM now()-cleared_at)/60)::float8 AS cleared_minutes`,
    [subject],
  );
  const cleared = rows[0]?.cleared_minutes;
  await adminAlert({
    subject,
    body,
    dedupMinutes:
      cleared == null ? reminderMinutes : Math.min(reminderMinutes, cleared),
  });
}

export async function conditionCleared(subject: string): Promise<void> {
  await getPool().query(
    `UPDATE admin_alert_state SET active=false, cleared_at=now(), updated_at=now()
     WHERE subject=$1 AND active`,
    [subject],
  );
}

/** Hosts in a stable order, so an unchanged condition has an unchanged body. */
export function byHostId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
