/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  Conversation,
  ListedConversation,
} from "@cocalc/util/conversations";
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

export interface ConversationsApi {
  list(opts: { account_id?: string }): Promise<ConversationList>;
  // The shared record only (no personal state), for opening a link.
  get(opts: ConversationRef): Promise<Conversation | null>;
  // Make a .chat file a conversation. Idempotent. The browser creates the
  // file for a new conversation first, then calls this.
  addExisting(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    title: string;
  }): Promise<Conversation>;
  // Called when a human sends a chat message in CoCalc; no-op unless the
  // file is a conversation.
  touch(opts: {
    account_id?: string;
    project_id: string;
    path: string;
  }): Promise<{ conversation_id?: string }>;
  rename(opts: ConversationRef & { title: string }): Promise<Conversation>;
  // Forget the conversation record; the .chat file is not changed.
  remove(opts: ConversationRef): Promise<void>;
  setPinned(opts: ConversationRef & { pinned: boolean }): Promise<void>;
  markRead(opts: ConversationRef & { read_through: number }): Promise<void>;
}

export const conversations = {
  list: authFirstRequireAccount,
  get: authFirstRequireAccount,
  addExisting: authFirstRequireAccount,
  touch: authFirstRequireAccount,
  rename: authFirstRequireAccount,
  remove: authFirstRequireAccount,
  setPinned: authFirstRequireAccount,
  markRead: authFirstRequireAccount,
};
