/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  collaborationNotificationStore,
  lockCollaborationNotificationAttention,
  pruneCollaborationNotificationEvents,
  seedCollaborationNotificationJobs,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { CollaborationNotificationOutboxStore } from "@cocalc/util/collaboration-attention";
import { runCollaborationNotificationOutboxPass } from "./collaboration-outbox";

export {
  appendCollaborationNotificationEvents,
  ensureCollaborationNotificationSchema,
  readCollaborationNotificationPage,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";

/** The collaboration service supplies its trusted owner route/fabric call. The database
 * owns ingestion, leases/cursors and attention; this layer owns notification policy
 * and the existing notification graph/outbox delivery.
 */
export async function runCollaborationNotificationMaintenance(
  readPage: CollaborationNotificationOutboxStore["readPage"],
) {
  const bay_id = getConfiguredBayId();
  await seedCollaborationNotificationJobs(bay_id);
  await pruneCollaborationNotificationEvents(bay_id);
  return runCollaborationNotificationOutboxPass({
    store: collaborationNotificationStore(readPage, bay_id),
    lockAttention: lockCollaborationNotificationAttention,
  });
}
