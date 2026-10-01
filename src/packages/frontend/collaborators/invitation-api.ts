/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  PeopleInvitationProjectAction,
  PeopleInvitationPayload,
  PeopleInvitationTarget,
  PeopleInvitationsApi,
} from "@cocalc/util/people-invitations";
import type {
  InvitationDiscoveryRecipient,
  InvitationDiscoveryProject,
  PeopleInvitationDiscoveryApi,
} from "@cocalc/util/people-invitation-discovery";

/** UI boundary; the transport adapter owns account binding and owner routing. */
export type InvitationRecipient = InvitationDiscoveryRecipient;
export type InvitationProjectChoice = PeopleInvitationProjectAction;
export type InvitationProject = InvitationDiscoveryProject;
export type InvitationChannels = PeopleInvitationPayload["channels"];

/** No review token or send authorization survives a project-creation handoff. */
export interface InviteProjectsDraft {
  recipientQuery: string;
  recipient?: InvitationRecipient;
  projects: InvitationProjectChoice[];
  message: string;
  target?: PeopleInvitationTarget;
  channels: InvitationChannels;
  createdProjectIds: string[];
}

export interface InvitationDiscoveryApi {
  resolveRecipient: PeopleInvitationDiscoveryApi["resolveInvitationRecipient"];
  listProjects: PeopleInvitationDiscoveryApi["listInvitationProjects"];
}

export type InvitationApi = PeopleInvitationsApi &
  Partial<InvitationDiscoveryApi>;
