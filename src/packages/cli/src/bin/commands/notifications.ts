import { readFile } from "node:fs/promises";
import { Command } from "commander";

export type NotificationsCommandDeps = {
  withContext: any;
};

function pushString(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}

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

async function resolveBodyMarkdown(opts: {
  bodyMarkdown?: string;
  bodyFile?: string;
}): Promise<string> {
  const bodyMarkdown = `${opts.bodyMarkdown ?? ""}`.trim();
  const bodyFile = `${opts.bodyFile ?? ""}`.trim();
  if (bodyMarkdown && bodyFile) {
    throw new Error("use exactly one of --body-markdown or --body-file");
  }
  if (bodyMarkdown) {
    return bodyMarkdown;
  }
  if (bodyFile) {
    return await readFile(bodyFile, "utf8");
  }
  throw new Error("one of --body-markdown or --body-file is required");
}

export function registerNotificationsCommand(
  program: Command,
  deps: NotificationsCommandDeps,
): Command {
  const { withContext } = deps;
  const notifications = program
    .command("notifications")
    .description("notification inbox operations");
  const projector = notifications
    .command("projector")
    .description("notification projection admin operations");

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
    .command("create-mention")
    .description("create a mention notification")
    .requiredOption(
      "--project-id <project_id>",
      "source project id that owns the mention",
    )
    .requiredOption("--path <path>", "source path within the project")
    .requiredOption("--description <text>", "browser-facing mention summary")
    .requiredOption(
      "--target <account_id>",
      "target account id (repeat for multiple targets)",
      pushString,
      [],
    )
    .option("--fragment-id <fragment_id>", "optional source fragment id")
    .option("--actor-account-id <account_id>", "override actor account id")
    .option("--priority <priority>", "mention priority (low|normal|high)")
    .option(
      "--stable-source-id <id>",
      "stable source id for dedupe across repeated mention writes",
    )
    .action(
      async (
        opts: {
          projectId: string;
          path: string;
          description: string;
          target: string[];
          fragmentId?: string;
          actorAccountId?: string;
          priority?: string;
          stableSourceId?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "notifications create-mention",
          async (ctx) => {
            return await ctx.hub.notifications.createMention({
              source_project_id: opts.projectId.trim(),
              source_path: opts.path,
              source_fragment_id: opts.fragmentId?.trim() || undefined,
              actor_account_id: opts.actorAccountId?.trim() || undefined,
              target_account_ids: opts.target.map((target) => target.trim()),
              description: opts.description,
              priority: opts.priority?.trim() || undefined,
              stable_source_id: opts.stableSourceId?.trim() || undefined,
            });
          },
        );
      },
    );

  notifications
    .command("create-account-notice")
    .description("create an account_notice notification")
    .requiredOption(
      "--target <account_id>",
      "target account id (repeat for multiple targets)",
      pushString,
      [],
    )
    .requiredOption(
      "--severity <severity>",
      "notice severity (info|warning|error)",
    )
    .requiredOption("--title <title>", "notice title")
    .option(
      "--body-markdown <markdown>",
      "markdown body inline on the command line",
    )
    .option("--body-file <path>", "read markdown body from a file")
    .option(
      "--origin-label <label>",
      "optional origin label shown in the inbox",
    )
    .option("--action-link <url>", "optional action url")
    .option("--action-label <text>", "optional action label")
    .option("--dedupe-key <key>", "optional dedupe key")
    .action(
      async (
        opts: {
          target: string[];
          severity: string;
          title: string;
          bodyMarkdown?: string;
          bodyFile?: string;
          originLabel?: string;
          actionLink?: string;
          actionLabel?: string;
          dedupeKey?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "notifications create-account-notice",
          async (ctx) => {
            return await ctx.hub.notifications.createAccountNotice({
              target_account_ids: opts.target.map((target) => target.trim()),
              severity: opts.severity.trim(),
              title: opts.title,
              body_markdown: await resolveBodyMarkdown(opts),
              origin_label: opts.originLabel?.trim() || undefined,
              action_link: opts.actionLink?.trim() || undefined,
              action_label: opts.actionLabel?.trim() || undefined,
              dedupe_key: opts.dedupeKey?.trim() || undefined,
            });
          },
        );
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

  projector
    .command("status")
    .description("show local account_notification_index projector status")
    .action(async (command: Command) => {
      await withContext(
        command,
        "notifications projector status",
        async (ctx) => {
          return await ctx.hub.system.getAccountNotificationIndexProjectionStatus(
            {},
          );
        },
      );
    });

  projector
    .command("drain")
    .description(
      "apply unpublished notification target outbox rows to the local notification inbox projection",
    )
    .option("--bay-id <bay_id>", "override the bay id to drain for")
    .option("--limit <n>", "apply at most n unpublished outbox events")
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        opts: {
          bayId?: string;
          limit?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "notifications projector drain",
          async (ctx) => {
            return await ctx.hub.system.drainAccountNotificationIndexProjection(
              {
                bay_id: opts.bayId?.trim() || undefined,
                limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
                dry_run: !opts.write,
              },
            );
          },
        );
      },
    );

  projector
    .command("rebuild <account_id>")
    .description(
      "rebuild the account_notification_index rows for one home-bay account",
    )
    .option("--write", "apply changes instead of running a dry run", false)
    .action(
      async (
        account_id: string,
        opts: {
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "notifications projector rebuild",
          async (ctx) => {
            return await ctx.hub.system.rebuildAccountNotificationIndex({
              target_account_id: account_id,
              dry_run: !opts.write,
            });
          },
        );
      },
    );

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
