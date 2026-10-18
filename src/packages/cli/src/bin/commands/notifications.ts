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

const DURATION_UNITS_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** --since: an age such as 90m, 12h, 30d or 2w, or an ISO date or time. */
export function parseSince(
  raw: string | undefined,
  now = Date.now(),
): string | undefined {
  const value = `${raw ?? ""}`.trim();
  if (!value) return undefined;
  const age = /^([1-9][0-9]*)([mhdw])$/.exec(value);
  if (age) {
    return new Date(
      now - Number(age[1]) * DURATION_UNITS_MS[age[2]],
    ).toISOString();
  }
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) {
    throw new Error(
      "--since must be an age like 12h, 30d or 2w, or an ISO date or time",
    );
  }
  return time.toISOString();
}

// The list API's page size limit (MAX_NOTIFICATION_INBOX_LIST_LIMIT).
const MAX_PAGE = 300;

/** Every matching row, newest first. Pages follow notification_id, which
 * never changes, so a notification updated meanwhile is neither skipped nor
 * returned twice. */
export async function listAllNotifications(
  list: (opts: any) => Promise<any[]>,
  opts: Record<string, any>,
  pageSize = MAX_PAGE,
): Promise<any[]> {
  const rows: any[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await list({
      ...opts,
      limit: pageSize,
      page: after ? { after_notification_id: after } : {},
    });
    rows.push(...page);
    const last = page.at(-1);
    if (page.length < pageSize || last == null) break;
    if (last.notification_id === after)
      throw new Error("notification paging did not advance");
    after = last.notification_id;
  }
  // The list's own order: created_at, then updated_at (newest first, missing
  // last), then notification_id.
  const time = (value: any) =>
    value == null ? -Infinity : new Date(value).getTime();
  const newer = (a: number, b: number) =>
    a === b ? 0 : a === -Infinity ? 1 : b === -Infinity ? -1 : b - a;
  return rows.sort(
    (a, b) =>
      newer(time(a.created_at), time(b.created_at)) ||
      newer(time(a.updated_at), time(b.updated_at)) ||
      `${a.notification_id}`.localeCompare(`${b.notification_id}`),
  );
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
    .option("--limit <n>", "limit result rows (page size with --all)")
    .option(
      "--since <age-or-time>",
      "only notifications since then: an age like 12h, 30d or 2w, or an ISO date",
    )
    .option(
      "--all",
      "return every matching notification, following pages to the end",
      false,
    )
    .addHelpText(
      "after",
      `
Newest first. Without --all at most --limit rows (default 100, at most 300)
are returned. With --all, pages are followed to the end, so combine it with
--since or --state to bound the result. To see an inbox's shape first, use
"notifications summary".`,
    )
    .action(
      async (
        opts: {
          kind?: string;
          state?: string;
          projectId?: string;
          notificationId?: string;
          limit?: string;
          since?: string;
          all?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications list", async (ctx) => {
          const since = parseSince(opts.since);
          const query = {
            kind: opts.kind?.trim() || undefined,
            state: opts.state?.trim() || undefined,
            project_id: opts.projectId?.trim() || undefined,
            notification_id: opts.notificationId?.trim() || undefined,
            ...(since ? { since } : {}),
          };
          const limit = parseOptionalPositiveInteger(opts.limit, "--limit");
          if (opts.all) {
            return await listAllNotifications(
              (page) => ctx.hub.notifications.list(page),
              query,
              Math.min(limit ?? MAX_PAGE, MAX_PAGE),
            );
          }
          return await ctx.hub.notifications.list({ ...query, limit });
        });
      },
    );

  notifications
    .command("summary")
    .description(
      "counts of notifications grouped by kind, origin and title (largest first)",
    )
    .option("--kind <kind>", "filter by notification kind")
    .option(
      "--state <state>",
      "filter by inbox state (all|unread|saved|archived)",
    )
    .option("--project-id <project_id>", "filter by project id")
    .option(
      "--since <age-or-time>",
      "only notifications since then: an age like 12h, 30d or 2w, or an ISO date",
    )
    .action(
      async (
        opts: {
          kind?: string;
          state?: string;
          projectId?: string;
          since?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications summary", async (ctx) => {
          return await ctx.hub.notifications.summary({
            kind: opts.kind?.trim() || undefined,
            state: opts.state?.trim() || undefined,
            project_id: opts.projectId?.trim() || undefined,
            since: parseSince(opts.since),
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

  notifications
    .command("save <notification_ids...>")
    .description("save one or more notifications")
    .option("--unsave", "remove the saved flag instead of setting it", false)
    .action(
      async (
        notification_ids: string[],
        opts: {
          unsave?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications save", async (ctx) => {
          return await ctx.hub.notifications.save({
            notification_ids,
            saved: !opts.unsave,
          });
        });
      },
    );

  notifications
    .command("archive <notification_ids...>")
    .description("archive one or more notifications")
    .option(
      "--unarchive",
      "remove the archived flag instead of setting it",
      false,
    )
    .action(
      async (
        notification_ids: string[],
        opts: {
          unarchive?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "notifications archive", async (ctx) => {
          return await ctx.hub.notifications.archive({
            notification_ids,
            archived: !opts.unarchive,
          });
        });
      },
    );

  return notifications;
}
