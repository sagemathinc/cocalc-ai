import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { v5 as uuidv5 } from "uuid";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { receiveComputeResourceNotice } from "@cocalc/server/notifications/compute-resource";
import type { ComputeResourceNotice } from "@cocalc/util/compute-notifications";

const logger = getLogger("compute:funding:resource-notices");
let cursor = "00000000-0000-0000-0000-000000000000";

/** Work is durable before notification delivery starts. Never GC undelivered
 * funded work if work-queue retention is introduced. No provider action waits
 * for email or an account bay; lost replies retry the same account-home event.
 */
export async function deliverComputeResourceNotices(): Promise<void> {
  const { rows } = await getPool().query<{
    id: string;
    resource_id: string;
    resource_kind: "vm" | "volume";
    account_id: string;
    resource_name: string;
    action: string;
    state: string;
    idempotency_key: string;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT w.id,w.resource_id,w.resource_kind,w.action,w.state,w.idempotency_key,w.created_at,w.updated_at,
    COALESCE(v.owner_account_id,d.owner_account_id) AS account_id,
    COALESCE(v.name,d.name,'') AS resource_name,
    CASE WHEN w.action='stop' THEN v.stopped_at ELSE COALESCE(v.deleted_at,d.deleted_at) END AS completed_at
    FROM compute_resource_work w
    LEFT JOIN compute_vms v ON w.resource_kind='vm' AND v.id=w.resource_id
    LEFT JOIN compute_volumes d ON w.resource_kind='volume' AND d.id=w.resource_id
    WHERE COALESCE(v.owning_bay_id,d.owning_bay_id)=$1 AND w.id>$2
      AND w.action IN ('stop','delete','delete_volume')
      AND (w.idempotency_key LIKE 'course-%' OR w.idempotency_key LIKE 'volume-funding-stop:%'
        OR COALESCE(v.metadata#>'{billing,course_funding}',d.metadata#>'{billing,course_funding}') IS NOT NULL)
      AND CASE WHEN w.state='done' THEN w.payload->>'funding_notice_completed' IS DISTINCT FROM 'true'
        ELSE w.payload->>'funding_notice_requested' IS DISTINCT FROM 'true' END
    ORDER BY w.id LIMIT 25`,
    [getConfiguredBayId(), cursor],
  );
  cursor =
    rows.length === 25
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      // A work item may complete as a no-op after its generation is superseded.
      // Never call that a confirmed stop/deletion without a resource timestamp.
      if (
        row.state === "done" &&
        (!row.completed_at || row.completed_at < row.created_at)
      ) {
        await getPool().query(
          "UPDATE compute_resource_work SET payload=COALESCE(payload,'{}') || '{\"funding_notice_completed\":true}'::jsonb WHERE id=$1",
          [row.id],
        );
        continue;
      }
      const phase = row.state === "done" ? "completed" : "requested";
      const { home_bay_id: home } = await resolveAccountHomeBay({
        account_id: row.account_id,
      });
      // Multiple intents (timer, funding sweep, manual stop) can converge on
      // the same provider-confirmed edge. Emit its completion only once.
      const edge =
        phase === "completed"
          ? row.completed_at!.toISOString()
          : row.idempotency_key;
      const notice: ComputeResourceNotice = {
        id: uuidv5(
          `compute-resource:${getConfiguredBayId()}:${row.resource_id}:${row.action}:${edge}:${phase}`,
          uuidv5.URL,
        ),
        account_id: row.account_id,
        resource_id: row.resource_id,
        resource_kind: row.resource_kind,
        resource_name: row.resource_name.slice(0, 200),
        action: row.action === "stop" ? "stop" : "delete",
        phase,
        observed_at: (phase === "completed"
          ? row.completed_at!
          : row.created_at
        ).toISOString(),
      };
      if (home === getConfiguredBayId())
        await receiveComputeResourceNotice(notice);
      else
        await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home,
          timeout: 5000,
        }).computeFundingReceiveResourceNotice(notice);
      await getPool().query(
        `UPDATE compute_resource_work SET payload=COALESCE(payload,'{}') || $2::jsonb WHERE id=$1`,
        [row.id, JSON.stringify({ [`funding_notice_${phase}`]: true })],
      );
    } catch (err) {
      logger.warn("compute lifecycle notice pending", { work_id: row.id, err });
    }
  }
}
