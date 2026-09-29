/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import type {
  ScanAdmissionRequest,
  ScanAdmissionResult,
} from "@cocalc/util/collaboration-scan";
import type { PeopleInvitationDeliveryReceipt } from "@cocalc/util/people-invitations";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type {
  InspectInvitationProjectInput,
  InvitationDiscoveryProject,
} from "@cocalc/util/people-invitation-discovery";
import type {
  CollaborationParticipantContinuation,
  CollaborationParticipantProjection,
} from "@cocalc/util/collaboration-relations";
import type {
  CollaborationResource,
  CollaborationResourceQuery,
  CollaborationPage,
} from "@cocalc/util/collaborators";
export type CollaborationProjectResourceQuery = Omit<
  CollaborationResourceQuery,
  "scope"
> & { project_id: string };
import type {
  CollaborationNotificationJob,
  CollaborationNotificationPage,
  CollaborationNotificationObligation,
} from "@cocalc/util/collaboration-attention";

export interface CollaborationRoute {
  bay_id: string;
  epoch?: number;
}
export interface CollaborationRelocateRequest {
  project_id: string;
  host_id?: string;
  from_chat_path: string;
  to_chat_path: string;
  operation_id: string;
  expected_epoch: string;
  expected_destination_epoch: string | null;
}
export interface CollaborationInitializeRequest {
  project_id: string;
  host_id?: string;
  room_id: string;
  chat_path: string;
  requesting_account_id: string;
}
export interface CollaborationProjectionRequest {
  relation_after?: CollaborationParticipantContinuation;
  account_id: string;
  project_id: string;
  generation: string | null;
  revision: number;
  after_key: string;
}
export interface CollaborationAccessRequest {
  account_id: string;
  project_id: string;
  epoch: number;
}
export interface CollaborationAccessGrant {
  account_id: string;
  project_id: string;
  generation: string | null;
}
/** Owner-only relocation lineage; never accepted from host snapshots or exposed publicly. */
export interface CollaborationOwnedResource extends CollaborationResource {
  artifact_entry_ids?: string[];
  /** Owner-verified old typed IDs; used only for personal-state migration. */
  agent_resource_ids?: string[];
  /** Stored key before canonical publication; point lookups echo the caller's typed ID. */
  agent_catalog_resource_id?: string;
}
export type CollaborationProjectionPage =
  | { allowed: false }
  | {
      allowed: true;
      generation: string;
      /** Per-recipient membership cutover, independent of project visibility fencing. */
      attention_generation?: string;
      reset: boolean;
      complete: boolean;
      revision: number;
      after_key: string;
      relation_after?: CollaborationParticipantContinuation;
      items: {
        participants?: CollaborationParticipantProjection;
        entry_key: string;
        revision: number;
        resource: CollaborationOwnedResource | null;
        /** Owner-derived recipient cutover floor; no pre-membership history. */
        initial_activity?: number;
      }[];
    };
type RoutedApi = {
  [K in keyof CollaboratorsApi]: (
    opts: Parameters<CollaboratorsApi[K]>[0] & { route: CollaborationRoute },
  ) => ReturnType<CollaboratorsApi[K]>;
};
export type InterBayCollaboratorsApi = RoutedApi & {
  inspectProjectDemand(opts: {
    project_id: string;
    account_id: string;
    route: CollaborationRoute;
  }): Promise<{ remaining_ms: number }>;
  registerRevisionInterest(opts: {
    project_id: string;
    account_id: string;
    route: CollaborationRoute;
  }): Promise<{
    lease_id: string;
    expires_at: number;
    renew_after: number;
    watermark: { generation: string; revision: number } | null;
  }>;
  scanAtHome(
    opts: ScanAdmissionRequest & { route: CollaborationRoute },
  ): Promise<ScanAdmissionResult>;
  scanAtOwner(
    opts: ScanAdmissionRequest & { route: CollaborationRoute },
  ): Promise<ScanAdmissionResult>;
  /** Service-only sender-authorized receipt lookup at the recipient's current home. */
  readInvitationDelivery(opts: {
    recipient_account_id: string;
    sender_account_id: string;
    notification_ids: string[];
    route: CollaborationRoute;
  }): Promise<
    { notification_id: string; delivery: PeopleInvitationDeliveryReceipt[] }[]
  >;
  inspectInvitationProject(
    opts: InspectInvitationProjectInput,
  ): Promise<InvitationDiscoveryProject | null>;
  listProjectResources(
    opts: CollaborationProjectResourceQuery & { route: CollaborationRoute },
  ): Promise<CollaborationPage<CollaborationResource>>;
  ownedProjectResources(
    opts: CollaborationProjectResourceQuery & { route: CollaborationRoute },
  ): Promise<CollaborationPage<CollaborationOwnedResource>>;
  /** Trusted owner-routed worker only; not part of the public account/host API. */
  notificationPage(opts: {
    job: CollaborationNotificationJob;
    limit: number;
    route: CollaborationRoute;
  }): Promise<CollaborationNotificationPage>;
  notificationObligation(
    opts: CollaborationNotificationObligation & {
      route: CollaborationRoute;
    },
  ): Promise<
    | Extract<
        CollaborationNotificationPage,
        { allowed: true }
      >["entries"][number]
    | null
  >;
  deliverNotificationObligation(
    opts: CollaborationNotificationObligation & {
      route: CollaborationRoute;
    },
  ): Promise<{
    status: "created" | "duplicate" | "suppressed" | "revoked";
    notification_id?: string;
  }>;
  refreshAccess(opts: {
    route: CollaborationRoute;
    requests: CollaborationAccessRequest[];
  }): Promise<CollaborationAccessGrant[]>;
  relocateSource(
    opts: CollaborationRelocateRequest & { route: CollaborationRoute },
  ): Promise<{ epoch: string; revision: number }>;
  markRoomInitialized(
    opts: CollaborationInitializeRequest & { route: CollaborationRoute },
  ): Promise<{
    project_id: string;
    room_id: string;
    chat_path: string;
    initialized: boolean;
  }>;
  check(opts: {
    account_id?: string;
    since?: string;
    route: CollaborationRoute;
  }): Promise<{
    revision: string;
    reset: boolean;
    poll_after_ms: number;
    demand_supported?: boolean;
  }>;
  writerState(opts: {
    project_id: string;
    chat_path: string;
    host_id?: string;
    route: CollaborationRoute;
  }): Promise<{
    epoch: string;
    registration_id: string | null;
    source_sequence: number;
    writer_host_id: string;
    retired_room_id?: string;
    canonical_room?: Awaited<ReturnType<CollaboratorsApi["roomForHost"]>>;
  } | null>;
  sourcePage(opts: {
    project_id: string;
    host_id?: string;
    after?: string;
    route: CollaborationRoute;
  }): Promise<{ paths: string[]; next?: string }>;
  projectPage(
    opts: CollaborationProjectionRequest & { route: CollaborationRoute },
  ): Promise<CollaborationProjectionPage>;
  ownedResource(
    opts: Parameters<CollaboratorsApi["getResource"]>[0] & {
      route: CollaborationRoute;
    },
  ): Promise<CollaborationOwnedResource | null>;
};
function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.collaborators.v1`;
}
export function createInterBayCollaboratorsClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayCollaboratorsApi {
  return createServiceClient<InterBayCollaboratorsApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-collaborators",
    timeout: 15000,
  });
}
export function createInterBayCollaboratorsHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayCollaboratorsApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayCollaboratorsApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-collaborators",
  });
}
