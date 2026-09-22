import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import getSpendableBalance from "@cocalc/server/purchases/get-spendable-balance";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";
import { toDecimal } from "@cocalc/util/money";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import { notifyLowCourseCredit } from "./course-credit";
import { notifyLowSponsoredCompute } from "./sponsored-compute";

const logger = getLogger("notifications:low-credit");

export async function notifyLowCredit(accountId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locks } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      [`low-credit:${accountId}`],
    );
    if (!locks[0]?.locked) {
      await client.query("COMMIT");
      return false;
    }
    const bay = getConfiguredBayId();
    // Null ownership is the documented original one-bay case, not this bay.
    const { rows: accounts } = await client.query<{
      other_settings: Record<string, unknown>;
    }>(
      `SELECT other_settings FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE
       AND COALESCE(NULLIF(home_bay_id,''),$3)=$2 FOR SHARE`,
      [accountId, bay, DEFAULT_BAY_ID],
    );
    const threshold = lowCreditThreshold(accounts[0]?.other_settings);
    if (threshold === undefined) {
      await client.query("COMMIT");
      return false;
    }
    const key = `low-credit:${accountId}`;
    const { rows: existing } = await client.query(
      "SELECT 1 FROM notification_targets WHERE target_account_id=$1 AND dedupe_key=$2 AND created_at > NOW() - interval '24 hours' LIMIT 1",
      [accountId, key],
    );
    if (existing.length) {
      await client.query("COMMIT");
      return false;
    }
    const balance = toDecimal(
      await getSpendableBalance({
        account_id: accountId,
        client,
        noSave: true,
      }),
    );
    if (!balance.lessThan(threshold)) {
      await client.query("COMMIT");
      return false;
    }
    const summary = {
      title: "Personal credit is low",
      severity: "warning",
      origin_label: "Account credit",
      notice_type: "low_personal_credit",
      body_markdown: `Personal spendable credit is $${balance.toFixed(2)} USD, below your $${threshold.toFixed(2)} USD reminder threshold. This excludes held funds and is separate from course funding. Checked ${new Date().toISOString()}.`,
      action_label: "View VMs",
      action_link: "/hosts?tab=vms",
    };
    await createNotificationEventGraphInTransaction({
      db: client,
      input: {
        kind: "account_notice",
        source_bay_id: bay,
        origin_kind: "system",
        payload_json: summary,
        targets: [
          {
            target_account_id: accountId,
            target_home_bay_id: bay,
            dedupe_key: key,
            summary_json: summary,
          },
        ],
      },
    });
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runLowCreditNotificationPass(
  afterAccountId?: string,
): Promise<string | undefined> {
  const { rows } = await getPool().query<{ account_id: string }>(
    `SELECT account_id FROM accounts WHERE deleted IS NOT TRUE
      AND COALESCE(NULLIF(home_bay_id,''),$2)=$1
      AND (other_settings->'low_credit_notifications' = 'true'::jsonb
        OR other_settings->'low_course_credit_notifications' = 'true'::jsonb
        OR other_settings->'low_sponsored_compute_notifications' = 'true'::jsonb)
      AND ($3::uuid IS NULL OR account_id > $3)
     ORDER BY account_id LIMIT 100`,
    [getConfiguredBayId(), DEFAULT_BAY_ID, afterAccountId ?? null],
  );
  for (const { account_id } of rows) {
    try {
      await notifyLowCredit(account_id);
    } catch (err) {
      logger.warn("low credit notification deferred", { account_id, err });
    }
    try {
      await notifyLowCourseCredit(account_id);
    } catch (err) {
      logger.warn("course credit notification deferred", { account_id, err });
    }
    try {
      await notifyLowSponsoredCompute(account_id);
    } catch (err) {
      logger.warn("sponsored compute notification deferred", {
        account_id,
        err,
      });
    }
  }
  return rows.length === 100 ? rows[rows.length - 1].account_id : undefined;
}

let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let cursor: string | undefined;
export function startLowCreditNotificationMaintenance() {
  if (timer) return;
  const tick = () => {
    if (active) return;
    active = runLowCreditNotificationPass(cursor)
      .then((next) => {
        cursor = next;
      })
      .catch((err) =>
        logger.warn("low credit notification pass failed", { err }),
      )
      .finally(() => {
        active = undefined;
      });
  };
  timer = setInterval(tick, 60000);
  timer.unref?.();
  tick();
}
export function stopLowCreditNotificationMaintenance() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
