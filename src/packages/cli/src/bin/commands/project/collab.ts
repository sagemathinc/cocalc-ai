/**
 * Project collaborator and invite management commands.
 *
 * Includes account search, collaborator listings, invite lifecycle operations,
 * and block list controls for collaboration access.
 */
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type ProjectCollaboratorRow = any;
type MyCollaboratorRow = any;
type ProjectCollabInviteRow = any;
type ProjectCollabInviteDirection = any;
type ProjectCollabInviteStatus = any;
type ProjectCollabInviteAction = any;
type ProjectCollabInviteBlockRow = any;

export function registerProjectCollabCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    normalizeUserSearchName,
    resolveProjectFromArgOrContext,
    toIso,
    resolveAccountByIdentifier,
    serializeInviteRow,
    compactInviteRow,
  } = deps;

  const collab = project
    .command("collab")
    .description("project collaborator operations");

  collab
    .command("search <query>")
    .description("search for existing accounts by name/email/account id")
    .option("--limit <n>", "max rows", "20")
    .action(
      async (query: string, opts: { limit?: string }, command: Command) => {
        await withContext(command, "project collab search", async (ctx) => {
          const limit = Math.max(
            1,
            Math.min(100, Number(opts.limit ?? "20") || 20),
          );
          const rows = await ctx.hub.system.userSearch({
            query,
            limit,
            ...(query.includes("@") ? { only_email: true } : undefined),
          });
          return (rows ?? []).map((row) => ({
            account_id: row.account_id,
            name: normalizeUserSearchName(row),
            first_name: row.first_name ?? null,
            last_name: row.last_name ?? null,
            email_address: row.email_address ?? null,
            last_active: row.last_active ?? null,
            created: row.created ?? null,
          }));
        });
      },
    );

  collab
    .command("list")
    .description("list collaborators for a project or all your collaborators")
    .option("-w, --project <project>", "project id or name")
    .option("--limit <n>", "max rows for account-wide listing", "500")
    .action(
      async (opts: { project?: string; limit?: string }, command: Command) => {
        await withContext(command, "project collab list", async (ctx) => {
          if (opts.project) {
            const project = await resolveProjectFromArgOrContext(
              ctx,
              opts.project,
            );
            const rows = (await ctx.hub.projects.listCollaborators({
              project_id: project.project_id,
            })) as ProjectCollaboratorRow[];
            return (rows ?? []).map((row) => ({
              project_id: project.project_id,
              project_title: project.title,
              account_id: row.account_id,
              group: row.group,
              name:
                `${row.name ?? ""}`.trim() ||
                `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
                null,
              first_name: row.first_name ?? null,
              last_name: row.last_name ?? null,
              email_address: row.email_address ?? null,
              last_active: toIso(row.last_active),
            }));
          }
          const limit = Math.max(
            1,
            Math.min(1000, Number(opts.limit ?? "500") || 500),
          );
          const rows = (await ctx.hub.projects.listMyCollaborators({
            limit,
          })) as MyCollaboratorRow[];
          return (rows ?? []).map((row) => ({
            account_id: row.account_id,
            name:
              `${row.name ?? ""}`.trim() ||
              `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
              null,
            first_name: row.first_name ?? null,
            last_name: row.last_name ?? null,
            email_address: row.email_address ?? null,
            last_active: toIso(row.last_active),
            shared_projects: row.shared_projects ?? 0,
          }));
        });
      },
    );

  collab
    .command("add")
    .description("invite (default) or directly add a collaborator to a project")
    .requiredOption("-w, --project <project>", "project id or name")
    .requiredOption("--user <user>", "target account id, username, or email")
    .option("--message <message>", "optional invite message")
    .option(
      "--direct",
      "directly add collaborator instead of creating an invite (admin only)",
    )
    .action(
      async (
        opts: {
          project: string;
          user: string;
          message?: string;
          direct?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project collab add", async (ctx) => {
          const project = await resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          const target = await resolveAccountByIdentifier(ctx, opts.user);
          const result = (await ctx.hub.projects.createCollabInvite({
            project_id: project.project_id,
            invitee_account_id: target.account_id,
            message: opts.message,
            direct: !!opts.direct,
          })) as {
            created: boolean;
            invite: ProjectCollabInviteRow;
          };
          return {
            project_id: project.project_id,
            project_title: project.title,
            target_account_id: target.account_id,
            target_name: normalizeUserSearchName(target),
            created: result.created,
            invite: serializeInviteRow(result.invite),
          };
        });
      },
    );

  collab
    .command("remove")
    .description("remove a collaborator from a project")
    .requiredOption("-w, --project <project>", "project id or name")
    .requiredOption("--user <user>", "target account id, username, or email")
    .action(
      async (opts: { project: string; user: string }, command: Command) => {
        await withContext(command, "project collab remove", async (ctx) => {
          const project = await resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          const target = await resolveAccountByIdentifier(ctx, opts.user);
          await ctx.hub.projects.removeCollaborator({
            opts: {
              project_id: project.project_id,
              account_id: target.account_id,
            },
          });
          return {
            project_id: project.project_id,
            project_title: project.title,
            target_account_id: target.account_id,
            target_name: normalizeUserSearchName(target),
            status: "removed",
          };
        });
      },
    );

  const invite = project
    .command("invite")
    .description("manage project collaboration invites");

  invite
    .command("list")
    .description("list collaboration invites")
    .option("-w, --project <project>", "project id or name")
    .option("--direction <direction>", "inbound, outbound, or all", "all")
    .option(
      "--status <status>",
      "pending, accepted, declined, blocked, expired, canceled",
      "pending",
    )
    .option("--limit <n>", "max rows", "200")
    .option("--full", "include full invite metadata")
    .action(
      async (
        opts: {
          project?: string;
          direction?: ProjectCollabInviteDirection;
          status?: ProjectCollabInviteStatus;
          limit?: string;
          full?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project invite list", async (ctx) => {
          const project = opts.project
            ? await resolveProjectFromArgOrContext(ctx, opts.project)
            : null;
          const limit = Math.max(
            1,
            Math.min(1000, Number(opts.limit ?? "200") || 200),
          );
          const rows = (await ctx.hub.projects.listCollabInvites({
            project_id: project?.project_id,
            direction: opts.direction,
            status: opts.status,
            limit,
          })) as ProjectCollabInviteRow[];
          if (opts.full) {
            return (rows ?? []).map((row) => ({
              ...serializeInviteRow(row),
              project_id: row.project_id,
              project_title: row.project_title ?? null,
            }));
          }
          return (rows ?? []).map((row) =>
            compactInviteRow(row, ctx.accountId),
          );
        });
      },
    );

  async function respondProjectInvite(
    command: Command,
    inviteId: string,
    action: ProjectCollabInviteAction,
  ): Promise<void> {
    await withContext(command, `project invite ${action}`, async (ctx) => {
      const row = (await ctx.hub.projects.respondCollabInvite({
        invite_id: inviteId,
        action,
      })) as ProjectCollabInviteRow;
      return serializeInviteRow(row);
    });
  }

  invite
    .command("accept <inviteId>")
    .description("accept an invite")
    .action(async (inviteId: string, command: Command) => {
      await respondProjectInvite(command, inviteId, "accept");
    });

  invite
    .command("decline <inviteId>")
    .description("decline an invite")
    .action(async (inviteId: string, command: Command) => {
      await respondProjectInvite(command, inviteId, "decline");
    });

  invite
    .command("block <inviteId>")
    .description("block inviter and mark invite as blocked")
    .action(async (inviteId: string, command: Command) => {
      await respondProjectInvite(command, inviteId, "block");
    });

  invite
    .command("revoke <inviteId>")
    .description("revoke (cancel) an outstanding invite you sent")
    .action(async (inviteId: string, command: Command) => {
      await respondProjectInvite(command, inviteId, "revoke");
    });

  invite
    .command("blocks")
    .description("list accounts you have blocked from inviting you")
    .option("--limit <n>", "max rows", "200")
    .action(async (opts: { limit?: string }, command: Command) => {
      await withContext(command, "project invite blocks", async (ctx) => {
        const limit = Math.max(
          1,
          Math.min(1000, Number(opts.limit ?? "200") || 200),
        );
        const rows = (await ctx.hub.projects.listCollabInviteBlocks({
          limit,
        })) as ProjectCollabInviteBlockRow[];
        return (rows ?? []).map((row) => ({
          blocker_account_id: row.blocker_account_id,
          blocked_account_id: row.blocked_account_id,
          blocked_name:
            `${row.blocked_name ?? ""}`.trim() ||
            `${row.blocked_first_name ?? ""} ${row.blocked_last_name ?? ""}`.trim() ||
            null,
          blocked_email_address: row.blocked_email_address ?? null,
          created: toIso(row.created),
          updated: toIso(row.updated),
        }));
      });
    });

  invite
    .command("unblock")
    .description("unblock a previously blocked inviter")
    .requiredOption("--user <user>", "blocked account id, username, or email")
    .action(async (opts: { user: string }, command: Command) => {
      await withContext(command, "project invite unblock", async (ctx) => {
        const user = await resolveAccountByIdentifier(ctx, opts.user);
        return (await ctx.hub.projects.unblockCollabInviteSender({
          blocked_account_id: user.account_id,
        })) as {
          unblocked: boolean;
          blocker_account_id: string;
          blocked_account_id: string;
        };
      });
    });
}
