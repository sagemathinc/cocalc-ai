/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ProjectViewerReadPolicy } from "./project-access";
import type {
  PeopleInvitationRecipient,
  PeopleInvitationTarget,
} from "./people-invitations";

export type InvitationDiscoveryRecipient = PeopleInvitationRecipient & {
  label: string;
  username?: string;
};
export interface InvitationDiscoveryProject {
  project_id: string;
  title: string;
  current_access: "owner" | "collaborator" | "viewer" | "none" | "unknown";
  read_policy?: ProjectViewerReadPolicy;
  content_access: "allowed" | "denied" | "unknown";
  can_invite: boolean;
  can_notify: boolean;
  unavailable_reason?: string;
  pending?: {
    role: "collaborator" | "viewer";
    read_policy?: ProjectViewerReadPolicy;
  };
}
export interface ResolveInvitationRecipientInput {
  account_id?: string;
  query: string;
}
export interface ResolveInvitationRecipientResult {
  recipients: InvitationDiscoveryRecipient[];
  notice?: string;
}
export interface ListInvitationProjectsInput {
  account_id?: string;
  recipient: PeopleInvitationRecipient & { label?: string; username?: string };
  query?: string;
  cursor?: string;
  project_ids?: string[];
  target?: PeopleInvitationTarget;
}
export interface ListInvitationProjectsResult {
  projects: InvitationDiscoveryProject[];
  next_cursor?: string;
  total?: number;
  notice?: string;
}
export interface PeopleInvitationDiscoveryApi {
  resolveInvitationRecipient(
    input: ResolveInvitationRecipientInput,
  ): Promise<ResolveInvitationRecipientResult>;
  listInvitationProjects(
    input: ListInvitationProjectsInput,
  ): Promise<ListInvitationProjectsResult>;
}
/** Trusted project-owner inspection; contact provenance is checked at account home. */
export interface InspectInvitationProjectInput {
  account_id: string;
  project_id: string;
  recipient: PeopleInvitationRecipient;
  target?: PeopleInvitationTarget;
  route: { bay_id: string; epoch?: number };
}
