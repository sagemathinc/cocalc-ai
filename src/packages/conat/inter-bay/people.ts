/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type { Conversation, SharedWork } from "@cocalc/util/people";
import type { PeopleApi } from "@cocalc/conat/hub/api/people";

// Trusted bay-to-bay calls. "Owner" methods run on the project's owning bay;
// "home" methods run on the account's home bay. Each side re-checks that it
// is the authority before touching its tables.
export interface InterBayPeopleApi {
  // owner
  listForProjects(opts: {
    account_id: string;
    project_ids: string[];
  }): Promise<Conversation[]>;
  getRecord(opts: {
    account_id: string;
    project_id: string;
    conversation_id: string;
  }): Promise<Conversation | null>;
  createRecord(opts: {
    account_id: string;
    project_id: string;
    path: string;
    title: string;
  }): Promise<Conversation>;
  touch(opts: {
    account_id: string;
    project_id: string;
    path: string;
  }): Promise<Conversation | null>;
  refresh(opts: {
    account_id: string;
    project_id: string;
    path: string;
    activity: number;
  }): Promise<Conversation | null>;
  rename(opts: {
    account_id: string;
    project_id: string;
    conversation_id: string;
    title: string;
  }): Promise<Conversation>;
  remove(opts: {
    account_id: string;
    project_id: string;
    conversation_id: string;
  }): Promise<void>;
  sharedWorkForProjects(opts: {
    viewer_id: string;
    person_id: string;
    project_ids: string[];
  }): Promise<SharedWork>;
  // home
  listSharedWork: PeopleApi["listSharedWork"];
  listConversations: PeopleApi["listConversations"];
  markRead: PeopleApi["markRead"];
  setState: PeopleApi["setState"];
  listStates: PeopleApi["listStates"];
  resolveAlias: PeopleApi["resolveAlias"];
}

function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.people.v1`;
}

export function createInterBayPeopleClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayPeopleApi {
  return createServiceClient<InterBayPeopleApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-people",
    timeout: 15000,
  });
}

export function createInterBayPeopleHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayPeopleApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayPeopleApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-people",
  });
}
