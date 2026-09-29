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
  PeopleInvitationPayload,
  PeopleInvitationProjectAction,
  PeopleInvitationPreflight,
  PeopleInvitationActionReceipt,
} from "@cocalc/util/people-invitations";

export interface PeopleActionInput {
  account_id: string;
  payload: PeopleInvitationPayload;
  action: PeopleInvitationProjectAction;
}
export interface PeopleAccessInput extends PeopleActionInput {
  child_operation_id: string;
}
export interface PeopleExecuteInput extends PeopleAccessInput {
  authorization_expires_at: number;
}
export interface PeopleActionRoute {
  bay_id: string;
  epoch?: number;
}
/** Trusted fabric only. These are not public hub or connector methods. */
export interface InterBayPeopleActionsApi {
  checkSender(input: {
    account_id: string;
    route: PeopleActionRoute;
  }): Promise<void>;
  preflight(
    input: PeopleActionInput & { route: PeopleActionRoute },
  ): Promise<PeopleInvitationPreflight>;
  inspect(
    input: PeopleAccessInput & { route: PeopleActionRoute },
  ): Promise<PeopleInvitationActionReceipt | undefined>;
  execute(
    input: PeopleExecuteInput & { route: PeopleActionRoute },
  ): Promise<PeopleInvitationActionReceipt>;
}
function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.people-actions.v1`;
}
export function createInterBayPeopleActionsClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayPeopleActionsApi {
  return createServiceClient<InterBayPeopleActionsApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-people-actions",
    timeout: 30000,
  });
}
export function createInterBayPeopleActionsHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayPeopleActionsApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayPeopleActionsApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-people-actions",
  });
}
