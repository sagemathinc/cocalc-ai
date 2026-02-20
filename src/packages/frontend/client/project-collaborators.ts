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
  }): Promise<ProjectCollabInviteRow[]> {
    return await this.conat.hub.projects.listCollabInvites(opts);
  }

  public async respond_invite(opts: {
    invite_id: string;
    action: ProjectCollabInviteAction;
  }): Promise<ProjectCollabInviteRow> {
    return await this.conat.hub.projects.respondCollabInvite(opts);
  }

  public async list_invite_blocks(opts?: {
    limit?: number;
  }): Promise<ProjectCollabInviteBlockRow[]> {
    return await this.conat.hub.projects.listCollabInviteBlocks(opts ?? {});
  }

  public async unblock_inviter(opts: {
    blocked_account_id: string;
  }): Promise<{ unblocked: boolean }> {
    return await this.conat.hub.projects.unblockCollabInviteSender(opts);
  }
}
