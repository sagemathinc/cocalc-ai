/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  DirectMessage,
  DirectPersonalPatch,
  DirectResponse,
  MemberDirectConversation,
} from "@cocalc/util/direct-conversations";
import type {
  Conversation,
  ListedConversation,
  PeopleStateKind,
  PersonalStatePatch,
  PersonalStateRow,
  SharedWork,
  ProjectAgent,
  AgentCollaboratorAccess,
} from "@cocalc/util/people";
import type {
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
} from "./projects";
import { authFirstRequireAccount } from "./util";
import type { AgentAppearance } from "@cocalc/util/agent-appearance";

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
  // Direct conversations, in no project (@cocalc/util/direct-conversations).
  listDirect(opts: {
    account_id?: string;
  }): Promise<{ conversations: MemberDirectConversation[] }>;
  // Start a conversation (or reuse the one with that person), optionally
  // with a first message. member_ids must be collaborators; anyone else is
  // named by exact username and gets a message request.
  startDirect(opts: {
    account_id?: string;
    member_ids?: string[];
    usernames?: string[];
    title?: string | null;
    body?: string | null;
  }): Promise<MemberDirectConversation>;
  // A page of messages, oldest first, before an optional time.
  getDirect(opts: {
    account_id?: string;
    conversation_id: string;
    before?: number | null;
  }): Promise<{
    conversation: MemberDirectConversation;
    messages: DirectMessage[];
  }>;
  sendDirect(opts: {
    account_id?: string;
    conversation_id: string;
    body: string;
  }): Promise<DirectMessage>;
  // Answer a message request (or block the person who started it).
  respondDirect(opts: {
    account_id?: string;
    conversation_id: string;
    action: DirectResponse;
  }): Promise<MemberDirectConversation>;
  markDirectRead(opts: {
    account_id?: string;
    conversation_id: string;
    read_through: number;
  }): Promise<void>;
  // Your own settings: mute, pin, archive (archived_through: a time, or
  // null to show everything again).
  setDirectState(opts: {
    account_id?: string;
    conversation_id: string;
    patch: DirectPersonalPatch;
  }): Promise<void>;
  // Delete a message you sent, for everyone.
  deleteDirectMessage(opts: {
    account_id?: string;
    conversation_id: string;
    message_id: string;
  }): Promise<void>;
  // Someone to message by exact username (never an account id or email), or
  // null. Start the conversation with the username.
  findDirectRecipient(opts: {
    account_id?: string;
    username: string;
  }): Promise<{ account_id: string; name: string; username: string } | null>;

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
  // Raise activity to a .chat file's modification time found by Scan.
  refreshConversation(opts: {
    account_id?: string;
    project_id: string;
    path: string;
    activity: number;
  }): Promise<{ conversation_id?: string }>;
  renameConversation(
    opts: ConversationRef & { title: string },
  ): Promise<Conversation>;
  // Forget the conversation record; the .chat file is not changed.
  removeConversation(opts: ConversationRef): Promise<void>;
  markRead(opts: ConversationRef & { read_through: number }): Promise<void>;

  // A collaborator's registered agents and their artifacts, in projects
  // shared with the caller.
  listSharedWork(opts: {
    account_id?: string;
    person_id: string;
  }): Promise<SharedWork & { unavailable_bays: number }>;

  // Registered agents other people created in projects shared with the
  // caller, newest first.
  listAgents(opts: {
    account_id?: string;
  }): Promise<{ agents: ProjectAgent[]; unavailable_bays: number }>;

  // Invites this account sent (from every bay that owns one of its projects)
  // or received (including the cross-bay inbox), newest first.
  listInvites(opts: {
    account_id?: string;
    direction: "inbound" | "outbound";
    status?: ProjectCollabInviteStatus;
  }): Promise<{ invites: ProjectCollabInviteRow[]; unavailable_bays: number }>;

  // An agent creator's stated preference for other collaborators.
  getAgentAccess(opts: {
    account_id?: string;
    project_id: string;
    agent_id: string;
  }): Promise<{ access: AgentCollaboratorAccess; is_creator: boolean } | null>;
  setAgentAccess(opts: {
    account_id?: string;
    project_id: string;
    agent_id: string;
    access: AgentCollaboratorAccess;
  }): Promise<void>;
  // Record the agent thread's theme (from its .chat) so lists show it
  // without loading the chat. Any project collaborator may.
  setAgentAppearance(opts: {
    account_id?: string;
    project_id: string;
    agent_id: string;
    appearance: AgentAppearance | null;
  }): Promise<void>;

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
  listDirect: authFirstRequireAccount,
  startDirect: authFirstRequireAccount,
  getDirect: authFirstRequireAccount,
  sendDirect: authFirstRequireAccount,
  respondDirect: authFirstRequireAccount,
  markDirectRead: authFirstRequireAccount,
  setDirectState: authFirstRequireAccount,
  deleteDirectMessage: authFirstRequireAccount,
  findDirectRecipient: authFirstRequireAccount,
  listConversations: authFirstRequireAccount,
  getConversation: authFirstRequireAccount,
  addConversation: authFirstRequireAccount,
  touchConversation: authFirstRequireAccount,
  refreshConversation: authFirstRequireAccount,
  renameConversation: authFirstRequireAccount,
  removeConversation: authFirstRequireAccount,
  markRead: authFirstRequireAccount,
  listSharedWork: authFirstRequireAccount,
  listAgents: authFirstRequireAccount,
  listInvites: authFirstRequireAccount,
  getAgentAccess: authFirstRequireAccount,
  setAgentAccess: authFirstRequireAccount,
  setAgentAppearance: authFirstRequireAccount,
  setState: authFirstRequireAccount,
  listStates: authFirstRequireAccount,
  resolveAlias: authFirstRequireAccount,
};
