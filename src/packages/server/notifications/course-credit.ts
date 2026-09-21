import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";
import { toDecimal } from "@cocalc/util/money";
import { v5 as uuidv5 } from "uuid";
import { ensureCourseCreditNoticeSchema } from "./course-credit-state";

export async function notifyLowCourseCredit(
  accountId: string,
): Promise<number> {
  const bay = getConfiguredBayId();
  const { rows } = await getPool().query(
    `SELECT other_settings FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE
      AND COALESCE(NULLIF(home_bay_id,''),$3)=$2`,
    [accountId, bay, DEFAULT_BAY_ID],
  );
  if (lowCreditThreshold(rows[0]?.other_settings, "course") === undefined)
    return 0;
  // Discovery may cross payer bays. Never hold account/financial locks over RPC.
  const { listSources } =
    await import("@cocalc/server/conat/api/compute-funding");
  const snapshot = await listSources({ account_id: accountId });
  const asOf = Date.parse(snapshot.as_of);
  if (!Number.isFinite(asOf) || Math.abs(Date.now() - asOf) > 120_000)
    throw Error("Course credit snapshot is stale or unavailable");
  await ensureCourseCreditNoticeSchema();
  return await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "send course credit reminders",
    fn: async (db) => {
      const { rows: accounts } = await db.query(
        "SELECT other_settings FROM accounts WHERE account_id=$1 FOR SHARE",
        [accountId],
      );
      const threshold = lowCreditThreshold(
        accounts[0]?.other_settings,
        "course",
      );
      if (threshold === undefined) return 0;
      let notices = 0;
      for (const source of snapshot.sources) {
        if (
          source.state !== "active" ||
          source.pool_state !== "active" ||
          Date.parse(source.starts_at) > asOf ||
          Date.parse(source.ends_at) <= asOf
        )
          continue;
        const available = toDecimal(source.available_usd);
        if (available.isNegative())
          throw Error("Course credit snapshot is invalid");
        const id = uuidv5(
          `course-credit:${accountId}:${source.grant_id}`,
          uuidv5.URL,
        );
        const previous = (
          await db.query(
            "SELECT * FROM notification_course_credit_states WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (previous && new Date(previous.as_of).getTime() >= asOf) continue;
        const below = available.lessThan(threshold);
        const crossed =
          below &&
          (!previous?.below_threshold ||
            Number(previous.threshold_usd) !== threshold);
        const generation = (previous?.generation ?? 0) + (crossed ? 1 : 0);
        await db.query(
          `INSERT INTO notification_course_credit_states
          (id,account_id,grant_id,threshold_usd,below_threshold,generation,as_of)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(id) DO UPDATE SET threshold_usd=$4,below_threshold=$5,generation=$6,as_of=$7`,
          [
            id,
            accountId,
            source.grant_id,
            threshold,
            below,
            generation,
            snapshot.as_of,
          ],
        );
        if (!crossed) continue;
        const summary = {
          title: `Course credit is low: ${source.label}`,
          severity: "warning",
          origin_label: "Course credit",
          notice_type: "low_course_credit",
          // Labels are user-authored: carry them as plain data, never Markdown.
          course_label: source.label,
          body_markdown: `Available course credit is $${available.toFixed(2)} USD, below your $${threshold.toFixed(2)} USD reminder threshold. This excludes reserved funds and is separate from personal credit. Checked ${snapshot.as_of}.`,
          action_label: "View course credit",
          action_link: "/hosts?tab=vms",
          pool_id: source.pool_id,
          grant_id: source.grant_id,
        };
        await createNotificationEventGraphInTransaction({
          db,
          input: {
            event_id: uuidv5(`crossing:${generation}`, id),
            kind: "account_notice",
            source_bay_id: bay,
            origin_kind: "system",
            payload_json: summary,
            targets: [
              {
                target_account_id: accountId,
                target_home_bay_id: bay,
                dedupe_key: `${id}:${generation}`,
                summary_json: summary,
              },
            ],
          },
        });
        notices++;
      }
      return notices;
    },
  });
}
