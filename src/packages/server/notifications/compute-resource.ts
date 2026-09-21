import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { ComputeResourceNotice } from "@cocalc/util/compute-notifications";
import { fundingId } from "@cocalc/util/compute-funding";

/** Internal bay-service endpoint. Delivery follows account authority, while the
 * work record and all resource operations remain at the owning bay.
 */
export async function receiveComputeResourceNotice(
  notice: ComputeResourceNotice,
): Promise<void> {
  for (const id of [notice.id, notice.account_id, notice.resource_id])
    fundingId(id, "Notice identity");
  if (
    !["vm", "volume"].includes(notice.resource_kind) ||
    !["stop", "delete"].includes(notice.action) ||
    !["requested", "completed"].includes(notice.phase) ||
    typeof notice.resource_name !== "string" ||
    notice.resource_name.length > 200 ||
    !Number.isFinite(Date.parse(notice.observed_at)) ||
    (notice.resource_kind === "volume" && notice.action === "stop")
  )
    throw Error("Invalid resource notice");
  await withAccountRehomeWriteFence({
    account_id: notice.account_id,
    action: "record compute notification",
    fn: async (db) => {
      const existing = await db.query(
        "SELECT target_account_id FROM notification_targets WHERE event_id=$1",
        [notice.id],
      );
      if (existing.rows.length) {
        if (
          existing.rows.length !== 1 ||
          existing.rows[0].target_account_id !== notice.account_id
        )
          throw Error("Conflicting resource notification identity");
        return;
      }
      const kind = notice.resource_kind === "vm" ? "VM" : "Home volume";
      const completed = notice.phase === "completed";
      const action =
        notice.action === "stop"
          ? completed
            ? "stopped"
            : "stop requested"
          : completed
            ? "deleted"
            : "deletion requested";
      const detail =
        notice.action === "stop"
          ? "Compute charges end after the provider confirms the stop. Storage can still incur charges until deletion."
          : notice.resource_kind === "vm"
            ? "The VM's boot disk, installed software, and data on that disk are removed on deletion. A separate home volume has its own retention and funding policy."
            : "Data on this home volume is removed on deletion. There is no automatic VM or volume backup.";
      const summary = {
        notice_type: "billing_compute_resource_lifecycle",
        title: `${kind} ${action}: ${notice.resource_name}`,
        severity: "warning",
        origin_label: "Compute billing",
        body_markdown: `${kind} ${action}. ${detail} Jupyter notebooks saved in your CoCalc project are not deleted. Checked ${new Date(notice.observed_at).toISOString()}.`,
        action_label: "View compute",
        action_link: "/hosts?tab=vms",
        resource_id: notice.resource_id,
        resource_kind: notice.resource_kind,
        lifecycle_action: notice.action,
        lifecycle_phase: notice.phase,
      };
      await createNotificationEventGraphInTransaction({
        db,
        input: {
          event_id: notice.id,
          kind: "account_notice",
          source_bay_id: getConfiguredBayId(),
          origin_kind: "system",
          payload_json: summary,
          targets: [
            {
              target_account_id: notice.account_id,
              target_home_bay_id: getConfiguredBayId(),
              dedupe_key: `compute-resource:${notice.id}`,
              summary_json: summary,
            },
          ],
        },
      });
    },
  });
}
