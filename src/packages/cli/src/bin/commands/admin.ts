import { Command } from "commander";
import { ADMIN_SEARCH_LIMIT } from "@cocalc/util/db-schema/accounts";

export type AdminCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  normalizeUrl: any;
  isValidUUID: any;
};

export function registerAdminCommand(program: Command, deps: AdminCommandDeps): Command {
  const { withContext, resolveAccountByIdentifier, normalizeUrl, isValidUUID } = deps;

  const admin = program.command("admin").description("site admin operations");
  const adminUser = admin.command("user").description("admin user management");

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
          if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
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
    .option("--no-first-project", "do not create/start an initial workspace")
    .action(
      async (
        opts: {
          email: string;
          password?: string;
          firstName?: string;
          lastName?: string;
          name?: string;
          tag?: string[];
          noFirstProject?: boolean;
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
            const parts = opts.name
              .trim()
              .split(/\s+/)
              .filter(Boolean);
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
            no_first_project: !!opts.noFirstProject,
            tags: opts.tag && opts.tag.length ? opts.tag : undefined,
          });

          return created;
        });
      },
    );

  adminUser
    .command("issue-auth-token <user>")
    .description(
      "issue an impersonation auth token for a user (account id, email, or name query)",
    )
    .option(
      "--password <password>",
      "password fallback for non-admin callers (normally not needed for admins)",
    )
    .option(
      "--lang <locale>",
      "optional lang_temp query parameter in generated sign-in URL",
    )
    .action(
      async (
        user: string,
        opts: {
          password?: string;
          lang?: string;
        },
        command: Command,
      ) => {
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

          const token = await ctx.hub.system.generateUserAuthToken({
            user_account_id: userAccountId,
            password: opts.password,
          });

          const base = normalizeUrl(ctx.apiBaseUrl).replace(/\/+$/, "");
          const signInUrl = new URL(`${base}/auth/impersonate`);
          signInUrl.searchParams.set("auth_token", token);
          if (opts.lang?.trim()) {
            signInUrl.searchParams.set("lang_temp", opts.lang.trim());
          }

          return {
            user_account_id: userAccountId,
            token,
            url: signInUrl.toString(),
          };
        });
      },
    );

  return admin;
}
