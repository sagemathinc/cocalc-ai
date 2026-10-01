/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  PeopleAccessInvitation,
  PeopleCollaborationInvitationHistoryRow,
  PeopleContact,
  PeopleInvitationQuery,
  PeopleInvitationCounts,
  PeopleInvitationPage,
  PeopleContactQuery,
  EnsurePeopleContact,
} from "@cocalc/util/people-invitation-history";
export interface PeopleInviteProjectionEvent {
  account_id: string;
  source_bay_id: string;
  source_epoch: number;
  invitation: PeopleAccessInvitation;
  deleted: boolean;
  // Only transported to the sender's authenticated home. Never persisted in
  // plaintext in an outbox/projection or sent to the accepting account.
  contact_email?: string;
}
export interface InterBayPeopleStorageApi {
  applyAccessProjection(opts: PeopleInviteProjectionEvent): Promise<void>;
  applyCollaborationProjection(opts: {
    account_id: string;
    source_bay_id: string;
    invitation: PeopleCollaborationInvitationHistoryRow;
  }): Promise<void>;
  listInvitationHistory(
    opts: PeopleInvitationQuery,
  ): Promise<PeopleInvitationPage>;
  getPeopleInvitationCounts(opts: {
    account_id: string;
  }): Promise<PeopleInvitationCounts>;
  listPeopleContacts(opts: PeopleContactQuery): Promise<{
    items: PeopleContact[];
    total: number;
    next_cursor?: string;
    revision: string;
  }>;
  getPeopleContact(opts: {
    account_id: string;
    person_id: string;
  }): Promise<PeopleContact | null>;
  ensurePeopleContact(opts: EnsurePeopleContact): Promise<PeopleContact>;
  archivePeopleContact(opts: {
    account_id: string;
    person_id: string;
    archived: boolean;
  }): Promise<void>;
}
function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.people-storage.v1`;
}
export function createInterBayPeopleStorageClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayPeopleStorageApi {
  return createServiceClient<InterBayPeopleStorageApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-people-storage",
    timeout: 15000,
  });
}
export function createInterBayPeopleStorageHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayPeopleStorageApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayPeopleStorageApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-people-storage",
  });
}
