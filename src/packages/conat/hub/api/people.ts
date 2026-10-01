/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  Conversation,
  ListedConversation,
  PeopleStateKind,
  PersonalStatePatch,
  PersonalStateRow,
} from "@cocalc/util/people";
import { authFirstRequireAccount } from "./util";

export interface ConversationRef {
  account_id?: string;
  project_id: string;
  conversation_id: string;
}

export interface ConversationList {
  conversations: ListedConversation[];
  // Bays that could not be reached; their conversations are missing.
  unavailable_bays: number;
}

export interface PeopleApi {
  listConversations(opts: { account_id?: string }): Promise<ConversationList>;
  // The shared record only (no personal state), for opening a link.
  getConversation(opts: ConversationRef): Promise<Conversation | null>;
  // Make a .chat file a conversation. Idempotent. The browser creates the
  // file for a new conversation first, then calls this.
  addConversation(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    title: string;
  }): Promise<Conversation>;
  // Called when a human sends a chat message in CoCalc; no-op unless the
  // file is a conversation.
  touchConversation(opts: {
    account_id?: string;
    project_id: string;
    path: string;
  }): Promise<{ conversation_id?: string }>;
  renameConversation(
    opts: ConversationRef & { title: string },
  ): Promise<Conversation>;
  // Forget the conversation record; the .chat file is not changed.
  removeConversation(opts: ConversationRef): Promise<void>;
  markRead(opts: ConversationRef & { read_through: number }): Promise<void>;

  // Private per-account state for conversations and people.
  setState(opts: {
    account_id?: string;
    kind: PeopleStateKind;
    target_id: string;
    project_id?: string;
    patch: PersonalStatePatch;
  }): Promise<PersonalStateRow>;
  listStates(opts: {
    account_id?: string;
    kind: PeopleStateKind;
  }): Promise<PersonalStateRow[]>;
  resolveAlias(opts: {
    account_id?: string;
    kind: PeopleStateKind;
    alias: string;
  }): Promise<{ target_id: string; project_id: string | null } | null>;
}

export const people = {
  listConversations: authFirstRequireAccount,
  getConversation: authFirstRequireAccount,
  addConversation: authFirstRequireAccount,
  touchConversation: authFirstRequireAccount,
  renameConversation: authFirstRequireAccount,
  removeConversation: authFirstRequireAccount,
  markRead: authFirstRequireAccount,
  setState: authFirstRequireAccount,
  listStates: authFirstRequireAccount,
  resolveAlias: authFirstRequireAccount,
};
