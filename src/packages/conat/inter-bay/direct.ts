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
  DirectMemberState,
  DirectMessage,
  DirectPersonalPatch,
  DirectResponse,
  ListedDirectConversation,
} from "@cocalc/util/direct-conversations";

// Trusted bay-to-bay calls for direct conversations. "Owner" methods run on
// the conversation's owning bay and check that the account is a member;
// "home" methods run on the account's home bay. Each side re-checks that it
// is the authority before touching its tables.
export interface InterBayDirectApi {
  // owner
  // From the starter's home bay, after its consent and quota checks: create
  // the conversation here, or (for a pair) return the existing one.
  create(opts: {
    // Chosen by the starter's home bay (its quota claim is keyed by it).
    conversation_id: string;
    account_id: string;
    member_ids: string[];
    member_states: Record<string, DirectMemberState>;
    title: string | null;
    pair_key: string | null;
    body: string | null;
  }): Promise<{ created: boolean; conversation: DirectConversation }>;
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
  // The sender deletes their own message, for everyone.
  deleteMessage(opts: {
    account_id: string;
    conversation_id: string;
    message_id: string;
  }): Promise<void>;
  // Every member's standing, for the trusted caller deciding whether to reuse
  // a conversation (never passed to a browser).
  standings(opts: {
    account_id: string;
    conversation_id: string;
  }): Promise<Record<string, DirectMemberState>>;
  // home
  // member_ids: collaborators only; anyone else by exact username.
  start(opts: {
    account_id: string;
    member_ids: string[];
    usernames?: string[];
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
    message?: Pick<
      DirectMessage,
      "message_id" | "sender_id" | "body" | "deleted"
    > | null;
    // Messages its sender deleted: this member's notices lose their text.
    deleted_message_ids?: string[];
  }): Promise<void>;
  isBlocked(opts: { account_id: string; sender_id: string }): Promise<boolean>;
  block(opts: {
    account_id: string;
    blocked_account_id: string;
  }): Promise<void>;
  unblock(opts: {
    account_id: string;
    blocked_account_id: string;
  }): Promise<void>;
  markRead(opts: {
    account_id: string;
    conversation_id: string;
    read_through: number;
  }): Promise<void>;
  setPersonal(opts: {
    account_id: string;
    conversation_id: string;
    patch: DirectPersonalPatch;
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
