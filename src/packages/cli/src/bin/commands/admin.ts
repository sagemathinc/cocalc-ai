import { Command } from "commander";
import { ADMIN_SEARCH_LIMIT } from "@cocalc/util/db-schema/accounts";
import { readFile } from "node:fs/promises";
import type { AccountEntitlementOverride } from "@cocalc/conat/hub/api/purchases";

export type AdminCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  isValidUUID: any;
};

type AccountEntitlementOverrideInput = Omit<
  Partial<AccountEntitlementOverride>,
  "account_id" | "updated_by" | "updated_at"
>;

function pushString(value: string, values: string[]): string[] {
  values.push(value);
  return values;
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

function parseOverrideJson(raw: string): AccountEntitlementOverrideInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid override JSON: ${err}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("override JSON must be an object");
  }
  return parsed as AccountEntitlementOverrideInput;
}

async function readOverrideFile(
  path: string,
): Promise<AccountEntitlementOverrideInput> {
  const filename = `${path ?? ""}`.trim();
  if (!filename) {
    throw new Error("--file is required");
  }
  return parseOverrideJson(await readFile(filename, "utf8"));
}

function parseExpiresAtOption(value: string | undefined): string | null | void {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return;
  if (/^(none|null|never)$/i.test(trimmed)) {
    return null;
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--expires-at must be ISO-8601, none, null, or never");
  }
  return date.toISOString();
}

function requireReason(value: string | undefined): string {
  const reason = `${value ?? ""}`.trim();
  if (!reason) {
    throw new Error("--reason is required");
  }
  return reason;
}

export function registerAdminCommand(
  program: Command,
  deps: AdminCommandDeps,
): Command {
  const { withContext, resolveAccountByIdentifier, isValidUUID } = deps;

  const admin = program.command("admin").description("site admin operations");
  const adminUser = admin.command("user").description("admin user management");
  const adminMessage = admin
    .command("message")
    .description("admin system message operations");
  const adminEntitlementOverride = admin
    .command("entitlement-override")
    .description("admin account entitlement override operations");

  async function resolveTargetAccountId(
    ctx: any,
    user: string,
  ): Promise<string> {
    const identifier = `${user ?? ""}`.trim();
    if (!identifier) {
      throw new Error("user identifier must be non-empty");
    }
    const resolved = isValidUUID(identifier)
      ? { account_id: identifier }
      : await resolveAccountByIdentifier(ctx, identifier);
    const userAccountId = `${resolved?.account_id ?? ""}`.trim();
    if (!userAccountId) {
      throw new Error(`unable to resolve account for '${identifier}'`);
    }
    return userAccountId;
  }

  admin
    .command("search <query>")
    .description(
      "search users by partial name, email, account_id, or project_id (admin-only)",
    )
    .option("--limit <n>", "max rows (default 20)")
    .option("--only-email", "search only by exact email matches")
    .action(
      async (
        query: string,
        opts: { limit?: string; onlyEmail?: boolean },
        command: Command,
      ) => {
        await withContext(command, "admin search", async (ctx) => {
          const normalizedQuery = `${query ?? ""}`.trim().toLowerCase();
          if (!normalizedQuery) {
            throw new Error("query must be non-empty");
          }

          const limit = opts.limit == null ? 20 : Number(opts.limit);
          if (
            !Number.isFinite(limit) ||
            !Number.isInteger(limit) ||
            limit <= 0
          ) {
            throw new Error("--limit must be a positive integer");
          }
          const cappedLimit = Math.min(limit, ADMIN_SEARCH_LIMIT);

          const rows = (await ctx.hub.system.userSearch({
            query: normalizedQuery,
            admin: true,
            limit: cappedLimit,
            only_email: !!opts.onlyEmail,
          })) as Array<{
            account_id: string;
            first_name?: string;
            last_name?: string;
            name?: string;
            email_address?: string;
            last_active?: number;
            created?: number;
            banned?: boolean;
            email_address_verified?: boolean;
          }>;

          return (rows ?? []).map((row) => ({
            account_id: row.account_id,
            name:
              `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
              row.name ||
              "",
            first_name: row.first_name ?? "",
            last_name: row.last_name ?? "",
            email_address: row.email_address ?? null,
            email_address_verified:
              row.email_address_verified == null
                ? null
                : !!row.email_address_verified,
            banned: row.banned == null ? null : !!row.banned,
            last_active: row.last_active ?? null,
            created: row.created ?? null,
          }));
        });
      },
    );

  admin
    .command("backup-shards")
    .description(
      "show project backup shard state and load (admin-only; seed-backed in multi-bay mode)",
    )
    .option("--region <region>", "restrict to a single backup region")
    .action(
      async (
        opts: {
          region?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin backup-shards", async (ctx) => {
          return await ctx.hub.system.getProjectBackupShards({
            region: opts.region?.trim() || undefined,
          });
        });
      },
    );

  adminUser
    .command("create")
    .description("create an account (admin only)")
    .requiredOption("--email <email>", "email address")
    .option(
      "--password <password>",
      "password (omit to auto-generate a random 24-character password)",
    )
    .option("--first-name <firstName>", "first name")
    .option("--last-name <lastName>", "last name")
    .option("--name <name>", "full name shorthand (split into first/last)")
    .option("--tag <tag...>", "optional account tags")
    .action(
      async (
        opts: {
          email: string;
          password?: string;
          firstName?: string;
          lastName?: string;
          name?: string;
          tag?: string[];
        },
        command: Command,
      ) => {
        await withContext(command, "admin user create", async (ctx) => {
          const email = `${opts.email ?? ""}`.trim();
          if (!email) {
            throw new Error("--email is required");
          }

          let firstName = opts.firstName?.trim();
          let lastName = opts.lastName?.trim();
          if (opts.name?.trim()) {
            const parts = opts.name.trim().split(/\s+/).filter(Boolean);
            if (!firstName && parts.length) {
              firstName = parts[0];
            }
            if (!lastName && parts.length > 1) {
              lastName = parts.slice(1).join(" ");
            }
          }

          const created = await ctx.hub.system.adminCreateUser({
            email,
            password: opts.password,
            first_name: firstName,
            last_name: lastName,
            tags: opts.tag && opts.tag.length ? opts.tag : undefined,
          });

          return created;
        });
      },
    );

  adminUser
    .command("issue-auth-token <user>")
    .description(
      "create an impersonation sign-in link for a user (account id, email, or name query)",
    )
    .action(async (user: string, _opts: {}, command: Command) => {
      await withContext(command, "admin user issue-auth-token", async (ctx) => {
        const identifier = `${user ?? ""}`.trim();
        if (!identifier) {
          throw new Error("user identifier must be non-empty");
        }

        const resolved = isValidUUID(identifier)
          ? { account_id: identifier }
          : await resolveAccountByIdentifier(ctx, identifier);
        const userAccountId = `${resolved?.account_id ?? ""}`.trim();
        if (!userAccountId) {
          throw new Error(`unable to resolve account for '${identifier}'`);
        }

        const grant = await ctx.hub.system.createImpersonationGrant({
          subject_account_id: userAccountId,
        });

        return {
          user_account_id: userAccountId,
          grant_id: grant.grant_id,
          subject_home_bay_id: grant.subject_home_bay_id,
          url: grant.url,
          expires_at: grant.expires_at,
        };
      });
    });

  adminEntitlementOverride
    .command("get <user>")
    .description("get the active admin entitlement override for a user")
    .action(async (user: string, command: Command) => {
      await withContext(
        command,
        "admin entitlement-override get",
        async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          const override = await ctx.hub.system.getAccountEntitlementOverride({
            user_account_id: userAccountId,
          });
          return {
            account_id: userAccountId,
            override: override ?? null,
          };
        },
      );
    });

  adminEntitlementOverride
    .command("set <user>")
    .description("set or replace the admin entitlement override for a user")
    .requiredOption("--file <path>", "JSON file containing the override object")
    .requiredOption("--reason <reason>", "required audit reason")
    .option(
      "--expires-at <iso>",
      "override expiration as ISO-8601, or none/null/never",
    )
    .action(
      async (
        user: string,
        opts: { file: string; reason: string; expiresAt?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin entitlement-override set",
          async (ctx) => {
            const userAccountId = await resolveTargetAccountId(ctx, user);
            const override = await readOverrideFile(opts.file);
            const expiresAt = parseExpiresAtOption(opts.expiresAt);
            if (expiresAt !== undefined) {
              override.expires_at = expiresAt;
            }
            const saved = await ctx.hub.system.setAccountEntitlementOverride({
              user_account_id: userAccountId,
              override,
              reason: requireReason(opts.reason),
            });
            return {
              account_id: userAccountId,
              override: saved,
            };
          },
        );
      },
    );

  adminEntitlementOverride
    .command("clear <user>")
    .description("clear the admin entitlement override for a user")
    .requiredOption("--reason <reason>", "required audit reason")
    .action(
      async (user: string, opts: { reason: string }, command: Command) => {
        await withContext(
          command,
          "admin entitlement-override clear",
          async (ctx) => {
            const userAccountId = await resolveTargetAccountId(ctx, user);
            await ctx.hub.system.clearAccountEntitlementOverride({
              user_account_id: userAccountId,
              reason: requireReason(opts.reason),
            });
            return {
              account_id: userAccountId,
              cleared: true,
            };
          },
        );
      },
    );

  adminMessage
    .command("send-system-notice")
    .description(
      "send a system-generated notice through the legacy messages pipeline",
    )
    .requiredOption(
      "--target <account_or_email>",
      "target account id or email address (repeat for multiple targets)",
      pushString,
      [],
    )
    .requiredOption("--subject <subject>", "short plain text subject")
    .option(
      "--body-markdown <markdown>",
      "markdown body inline on the command line",
    )
    .option("--body-file <path>", "read markdown body from a file")
    .option(
      "--dedup-minutes <minutes>",
      "optional dedupe window for repeated identical system notices",
    )
    .action(
      async (
        opts: {
          target: string[];
          subject: string;
          bodyMarkdown?: string;
          bodyFile?: string;
          dedupMinutes?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin message send-system-notice",
          async (ctx) => {
            const dedupMinutesRaw = `${opts.dedupMinutes ?? ""}`.trim();
            const parsedDedupMinutes =
              dedupMinutesRaw === ""
                ? undefined
                : Number.parseInt(dedupMinutesRaw, 10);
            if (
              dedupMinutesRaw !== "" &&
              (parsedDedupMinutes == null ||
                !Number.isInteger(parsedDedupMinutes) ||
                parsedDedupMinutes <= 0)
            ) {
              throw new Error("--dedup-minutes must be a positive integer");
            }
            const dedupMinutes = parsedDedupMinutes;
            return await ctx.hub.messages.sendSystemNotice({
              to_ids: opts.target.map((target) => target.trim()),
              subject: `${opts.subject ?? ""}`,
              body: await resolveBodyMarkdown(opts),
              dedupMinutes,
            });
          },
        );
      },
    );

  return admin;
}
