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
import type {
  DirectConversation,
  DirectMessage,
  DirectResponse,
  ListedDirectConversation,
} from "@cocalc/util/direct-conversations";

// Trusted bay-to-bay calls for direct conversations. "Owner" methods run on
// the conversation's owning bay and check that the account is a member;
// "home" methods run on the account's home bay. Each side re-checks that it
// is the authority before touching its tables.
export interface InterBayDirectApi {
  // owner
  messages(opts: {
    account_id: string;
    conversation_id: string;
    before?: number | null;
  }): Promise<{ conversation: DirectConversation; messages: DirectMessage[] }>;
  send(opts: {
    account_id: string;
    conversation_id: string;
    body: string;
  }): Promise<DirectMessage>;
  respond(opts: {
    account_id: string;
    conversation_id: string;
    action: DirectResponse;
  }): Promise<DirectConversation>;
  // home
  start(opts: {
    account_id: string;
    member_ids: string[];
    title?: string | null;
    body?: string | null;
  }): Promise<ListedDirectConversation>;
  list(opts: { account_id: string }): Promise<ListedDirectConversation[]>;
  getIndex(opts: {
    account_id: string;
    conversation_id: string;
  }): Promise<ListedDirectConversation | null>;
  // From the owning bay: the conversation changed. With a message, the
  // member may be notified.
  upsertIndex(opts: {
    account_id: string;
    conversation: DirectConversation;
    message?: Pick<DirectMessage, "message_id" | "sender_id" | "body"> | null;
  }): Promise<void>;
  isBlocked(opts: { account_id: string; sender_id: string }): Promise<boolean>;
  block(opts: {
    account_id: string;
    blocked_account_id: string;
  }): Promise<void>;
  markRead(opts: {
    account_id: string;
    conversation_id: string;
    read_through: number;
  }): Promise<void>;
  setMuted(opts: {
    account_id: string;
    conversation_id: string;
    muted: boolean;
  }): Promise<void>;
}

function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.direct.v1`;
}

export function createInterBayDirectClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayDirectApi {
  return createServiceClient<InterBayDirectApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-direct",
    timeout: 15000,
  });
}

export function createInterBayDirectHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayDirectApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayDirectApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-direct",
  });
}
