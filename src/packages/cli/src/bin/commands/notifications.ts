import { Command } from "commander";

export type NotificationsCommandDeps = {
  withContext: any;
};

function parseOptionalPositiveInteger(
  raw: string | undefined,
  flag: string,
): number | undefined {
  if (raw == null || `${raw}`.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function registerNotificationsCommand(
  program: Command,
  deps: NotificationsCommandDeps,
): Command {
  const { withContext } = deps;
  const notifications = program
    .command("notifications")
    .description("notification inbox operations");

  notifications
    .command("list")
    .description("list projected notifications for the signed-in account")
    .option("--kind <kind>", "filter by notification kind")
    .option(
      "--state <state>",
      "filter by inbox state (all|unread|saved|archived)",
    )
    .option("--project-id <project_id>", "filter by project id")
    .option(
      "--notification-id <notification_id>",
      "filter by one notification id",
    )
    .option("--limit <n>", "limit result rows")
    .action(
      async (
        opts: {
          kind?: string;
          state?: string;
          projectId?: string;
          notificationId?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications list", async (ctx) => {
          return await ctx.hub.notifications.list({
            kind: opts.kind?.trim() || undefined,
            state: opts.state?.trim() || undefined,
            project_id: opts.projectId?.trim() || undefined,
            notification_id: opts.notificationId?.trim() || undefined,
            limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
          });
        });
      },
    );

  notifications
    .command("counts")
    .description("show notification counts for the signed-in account")
    .action(async (command: Command) => {
      await withContext(command, "notifications counts", async (ctx) => {
        return await ctx.hub.notifications.counts({});
      });
    });

  notifications
    .command("mark-read <notification_ids...>")
    .description("mark one or more notifications as read")
    .option("--unread", "mark as unread instead of read", false)
    .action(
      async (
        notification_ids: string[],
        opts: {
          unread?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications mark-read", async (ctx) => {
          return await ctx.hub.notifications.markRead({
            notification_ids,
            read: !opts.unread,
          });
        });
      },
    );

  return notifications;
}
