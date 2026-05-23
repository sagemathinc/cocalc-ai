/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ConatClient } from "@cocalc/frontend/conat/client";
import type {
  AddCollaborator,
  ProjectCollabInviteAction,
  ProjectCollabInviteBlockRow,
  ProjectCollabInviteDirection,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
  ProjectCollaboratorInviteUsage,
} from "@cocalc/conat/hub/api/projects";

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
  }): Promise<any> {
    return await this.conat.hub.projects.inviteCollaboratorWithoutAccount({
      opts,
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

  public async copy_email_invite_link(opts: {
    invite_id: string;
    project_id?: string;
  }): Promise<{
    invite_id: string;
    invite_url: string;
    expires?: Date | null;
  }> {
    return await this.conat.hub.projects.copyEmailProjectInviteLink(opts);
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
