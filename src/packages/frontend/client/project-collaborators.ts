/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ConatClient } from "@cocalc/frontend/conat/client";
import type {
  AddCollaborator,
  ProjectAccessLandingInfo,
  ProjectAccessRequestAction,
  ProjectAccessRequestBlockRow,
  ProjectAccessRequestRow,
  ProjectAccessRequestSource,
  ProjectAccessRequestStatus,
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteDirection,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
  ProjectCollaboratorInviteUsage,
  ProjectCollaboratorRow,
} from "@cocalc/conat/hub/api/projects";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";

function browserOrigin(): string | undefined {
  if (typeof window === "undefined") {
    return;
  }
  return window.location?.origin;
}

export class ProjectCollaborators {
  private conat: ConatClient;

  constructor(client) {
    this.conat = client.conat_client;
  }

  public async invite_noncloud(opts: {
    project_id: string;
    title: string;
    link2proj: string;
    replyto?: string;
    replyto_name?: string;
    to: string;
    email: string; // body in HTML format
    subject?: string;
    message?: string;
    send_email?: boolean;
    invite_context?: Record<string, unknown>;
    invite_scope?: string;
    invite_role?: "collaborator" | "viewer";
    invite_base_url?: string;
    read_policy?: ProjectViewerReadPolicy | null;
  }): Promise<any> {
    return await this.conat.hub.projects.inviteCollaboratorWithoutAccount({
      opts: {
        ...opts,
        invite_base_url: opts.invite_base_url ?? browserOrigin(),
      },
    });
  }

  public async invite(opts: {
    project_id: string;
    account_id: string;
    title?: string;
    link2proj?: string;
    replyto?: string;
    replyto_name?: string;
    email?: string;
    subject?: string;
    message?: string;
    invite_role?: "collaborator" | "viewer";
    read_policy?: ProjectViewerReadPolicy | null;
  }): Promise<any> {
    return await this.conat.hub.projects.inviteCollaborator({
      opts,
    });
  }

  public async remove(opts: {
    project_id: string;
    account_id: string;
  }): Promise<any> {
    return await this.conat.hub.projects.removeCollaborator({
      opts,
    });
  }

  public async set_role(opts: {
    project_id: string;
    target_account_id: string;
    role: Exclude<ProjectCollaboratorRow["group"], "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
  }): Promise<void> {
    await this.conat.hub.projects.setProjectUserRole({ opts });
  }

  // Directly add one (or more) collaborators to (one or more) projects via
  // a single API call.  There is no defined invite email message.
  public async add_collaborator(
    opts: AddCollaborator,
  ): Promise<{ project_id?: string | string[] }> {
    // project_id is a single string or possibly an array of project_id's
    // in case of a token.
    return await this.conat.hub.projects.addCollaborator({
      opts,
    });
  }

  public async list_invites(opts: {
    project_id?: string;
    direction?: ProjectCollabInviteDirection;
    status?: ProjectCollabInviteStatus;
    limit?: number;
    projectWide?: boolean;
  }): Promise<ProjectCollabInviteRow[]> {
    return await this.conat.hub.projects.listCollabInvites(opts);
  }

  public async respond_invite(opts: {
    invite_id: string;
    project_id?: string;
    action: ProjectCollabInviteAction;
  }): Promise<ProjectCollabInviteRow> {
    return await this.conat.hub.projects.respondCollabInvite(opts);
  }

  public async get_access_landing_info(opts: {
    project_id: string;
  }): Promise<ProjectAccessLandingInfo> {
    return await this.conat.hub.projects.getProjectAccessLandingInfo(opts);
  }

  public async request_access(opts: {
    project_id: string;
    requested_role: "collaborator" | "viewer";
    read_policy?: ProjectViewerReadPolicy | null;
    message?: string;
    source?: ProjectAccessRequestSource | string;
  }): Promise<ProjectAccessRequestRow> {
    return await this.conat.hub.projects.requestProjectAccess(opts);
  }

  public async list_access_requests(opts: {
    project_id: string;
    status?: ProjectAccessRequestStatus;
    limit?: number;
  }): Promise<ProjectAccessRequestRow[]> {
    return await this.conat.hub.projects.listProjectAccessRequests(opts);
  }

  public async respond_access_request(opts: {
    project_id: string;
    request_id: string;
    action: ProjectAccessRequestAction;
    role?: "collaborator" | "viewer";
    read_policy?: ProjectViewerReadPolicy | null;
    message?: string;
  }): Promise<ProjectAccessRequestRow> {
    return await this.conat.hub.projects.respondProjectAccessRequest(opts);
  }

  public async list_access_request_blocks(opts: {
    project_id: string;
    limit?: number;
  }): Promise<ProjectAccessRequestBlockRow[]> {
    return await this.conat.hub.projects.listProjectAccessRequestBlocks(opts);
  }

  public async unblock_access_requester(opts: {
    project_id: string;
    blocked_account_id: string;
  }): Promise<{
    unblocked: boolean;
    project_id: string;
    blocked_account_id: string;
  }> {
    return await this.conat.hub.projects.unblockProjectAccessRequester(opts);
  }

  public async copy_email_invite_link(opts: {
    invite_id: string;
    project_id?: string;
    invite_base_url?: string;
  }): Promise<{
    invite_id: string;
    invite_url: string;
    expires?: Date | null;
  }> {
    return await this.conat.hub.projects.copyEmailProjectInviteLink({
      ...opts,
      invite_base_url: opts.invite_base_url ?? browserOrigin(),
    });
  }

  public async redeem_email_invite(opts: {
    invite_id?: string;
    token: string;
    project_id?: string;
  }): Promise<ProjectCollabInviteRow> {
    return await this.conat.hub.projects.redeemEmailProjectInvite(opts);
  }

  public async preview_email_invite(opts: {
    invite_id?: string;
    token: string;
    project_id?: string;
  }): Promise<ProjectCollabInviteRow> {
    return await this.conat.hub.projects.previewEmailProjectInvite(opts);
  }

  public async respond_email_invite(opts: {
    action: ProjectCollabInviteAction;
    invite_id?: string;
    token: string;
    project_id?: string;
  }): Promise<ProjectCollabInviteRow> {
    return await this.conat.hub.projects.respondEmailProjectInvite(opts);
  }

  public async list_invite_blocks(opts?: {
    limit?: number;
  }): Promise<ProjectCollabInviteBlockRow[]> {
    return await this.conat.hub.projects.listCollabInviteBlocks(opts ?? {});
  }

  public async get_invite_usage(opts: {
    project_id: string;
  }): Promise<ProjectCollaboratorInviteUsage> {
    return await this.conat.hub.projects.getProjectCollaboratorInviteUsage(
      opts,
    );
  }

  public async unblock_inviter(opts: {
    blocked_account_id: string;
  }): Promise<{ unblocked: boolean }> {
    return await this.conat.hub.projects.unblockCollabInviteSender(opts);
  }
}
