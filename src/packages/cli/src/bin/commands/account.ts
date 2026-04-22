import { Command } from "commander";

export type AccountCommandDeps = {
  withContext: any;
  toIso: any;
  resolveAccountByIdentifier: any;
};

export function registerAccountCommand(
  program: Command,
  deps: AccountCommandDeps,
): Command {
  const { withContext, toIso, resolveAccountByIdentifier } = deps;

  const account = program.command("account").description("account operations");

  account
    .command("where [account]")
    .description("show the home bay for an account")
    .action(async (accountIdentifier: string | undefined, command: Command) => {
      await withContext(command, "account where", async (ctx) => {
        const target = accountIdentifier?.trim()
          ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
          : { account_id: ctx.accountId };
        return await ctx.hub.system.getAccountBay({
          user_account_id: target.account_id,
        });
      });
    });

  account
    .command("delete [account]")
    .description(
      "delete an account (defaults to the signed-in account; admins can delete another account)",
    )
    .option(
      "--only-if-tag <tag>",
      "refuse deletion unless the target account has this tag",
    )
    .option("-y, --yes", "skip interactive safety confirmation")
    .action(
      async (
        accountIdentifier: string | undefined,
        opts: { onlyIfTag?: string; yes?: boolean },
        command: Command,
      ) => {
        await withContext(command, "account delete", async (ctx) => {
          const target = accountIdentifier?.trim()
            ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
            : { account_id: ctx.accountId, email_address: null, name: "" };
          const accountId = `${target.account_id ?? ""}`.trim();
          if (!accountId) {
            throw new Error("unable to resolve target account");
          }
          if (!opts.yes) {
            const label =
              `${target.email_address ?? target.name ?? ""}`.trim() ||
              accountId;
            throw new Error(
              `refusing to delete account '${label}' without --yes`,
            );
          }
          const result = await ctx.hub.system.deleteAccount({
            user_account_id: accountId,
            only_if_tag: `${opts.onlyIfTag ?? ""}`.trim() || undefined,
          });
          return {
            account_id: result.account_id,
            home_bay_id: result.home_bay_id,
            status: result.status,
            only_if_tag: `${opts.onlyIfTag ?? ""}`.trim() || null,
          };
        });
      },
    );

  account
    .command("rehome <account>")
    .description("move an account's home bay")
    .requiredOption("--bay <bay>", "destination account home bay")
    .option("--reason <reason>", "operator-visible reason")
    .option("--campaign <id>", "operator-visible batch/campaign id")
    .option("-y, --yes", "skip interactive safety confirmation")
    .action(
      async (
        accountIdentifier: string,
        opts: {
          bay?: string;
          reason?: string;
          campaign?: string;
          yes?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome", async (ctx) => {
          const target = await resolveAccountByIdentifier(
            ctx,
            accountIdentifier.trim(),
          );
          const accountId = `${target.account_id ?? ""}`.trim();
          if (!accountId) {
            throw new Error("unable to resolve target account");
          }
          const destBayId = `${opts.bay ?? ""}`.trim();
          if (!destBayId) {
            throw new Error("--bay is required");
          }
          if (!opts.yes) {
            const label =
              `${target.email_address ?? target.name ?? ""}`.trim() ||
              accountId;
            throw new Error(
              `refusing to rehome account '${label}' without --yes`,
            );
          }
          return await ctx.hub.system.rehomeAccount({
            user_account_id: accountId,
            dest_bay_id: destBayId,
            reason: `${opts.reason ?? ""}`.trim() || undefined,
            campaign_id: `${opts.campaign ?? ""}`.trim() || undefined,
          });
        });
      },
    );

  account
    .command("rehome-status")
    .description("show an account rehome operation")
    .requiredOption("--op-id <uuid>", "account rehome operation id")
    .option("--source-bay <bay>", "source bay that owns the rehome operation")
    .action(
      async (
        opts: {
          opId?: string;
          sourceBay?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome-status", async (ctx) => {
          const op = await ctx.hub.system.getAccountRehomeOperation({
            op_id: `${opts.opId ?? ""}`.trim(),
            source_bay_id: `${opts.sourceBay ?? ""}`.trim() || undefined,
          });
          if (!op) {
            throw new Error(`account rehome operation ${opts.opId} not found`);
          }
          return op;
        });
      },
    );

  account
    .command("rehome-reconcile")
    .description("retry/resume an account rehome operation")
    .requiredOption("--op-id <uuid>", "account rehome operation id")
    .option("--source-bay <bay>", "source bay that owns the rehome operation")
    .action(
      async (
        opts: {
          opId?: string;
          sourceBay?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome-reconcile", async (ctx) => {
          return await ctx.hub.system.reconcileAccountRehome({
            op_id: `${opts.opId ?? ""}`.trim(),
            source_bay_id: `${opts.sourceBay ?? ""}`.trim() || undefined,
          });
        });
      },
    );

  const accountApiKey = account
    .command("api-key")
    .description("manage account API keys");

  accountApiKey
    .command("list")
    .description("list account API keys")
    .action(async (command: Command) => {
      await withContext(command, "account api-key list", async (ctx) => {
        const rows = (await ctx.hub.system.manageApiKeys({
          action: "get",
        })) as Array<{
          id?: number;
          key_id?: string;
          name?: string;
          trunc?: string;
          created?: string | Date | null;
          expire?: string | Date | null;
          last_active?: string | Date | null;
          project_id?: string | null;
        }>;
        return (rows ?? []).map((row) => ({
          id: row.id,
          key_id: row.key_id ?? null,
          name: row.name ?? "",
          trunc: row.trunc ?? "",
          created: toIso(row.created),
          expire: toIso(row.expire),
          last_active: toIso(row.last_active),
          project_id: row.project_id ?? null,
        }));
      });
    });

  accountApiKey
    .command("create")
    .description("create an account API key")
    .option(
      "--name <name>",
      "key label",
      `cocalc-cli-${Date.now().toString(36)}`,
    )
    .option("--expire-seconds <n>", "expire in n seconds")
    .action(
      async (
        opts: {
          name?: string;
          expireSeconds?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account api-key create", async (ctx) => {
          const expireSeconds =
            opts.expireSeconds == null ? undefined : Number(opts.expireSeconds);
          if (
            expireSeconds != null &&
            (!Number.isFinite(expireSeconds) || expireSeconds <= 0)
          ) {
            throw new Error("--expire-seconds must be a positive number");
          }
          const expire = expireSeconds
            ? new Date(Date.now() + expireSeconds * 1000)
            : undefined;
          const rows = (await ctx.hub.system.manageApiKeys({
            action: "create",
            name: opts.name,
            expire,
          })) as Array<{
            id?: number;
            key_id?: string;
            name?: string;
            trunc?: string;
            secret?: string;
            created?: string | Date | null;
            expire?: string | Date | null;
            project_id?: string | null;
          }>;
          const key = rows?.[0];
          if (!key?.id) {
            throw new Error("failed to create api key");
          }
          return {
            id: key.id,
            key_id: key.key_id ?? null,
            name: key.name ?? opts.name ?? "",
            trunc: key.trunc ?? "",
            secret: key.secret ?? null,
            created: toIso(key.created),
            expire: toIso(key.expire),
            project_id: key.project_id ?? null,
          };
        });
      },
    );

  accountApiKey
    .command("delete <id>")
    .description("delete an account API key by id")
    .action(async (id: string, command: Command) => {
      await withContext(command, "account api-key delete", async (ctx) => {
        const keyId = Number(id);
        if (!Number.isInteger(keyId) || keyId <= 0) {
          throw new Error("id must be a positive integer");
        }
        await ctx.hub.system.manageApiKeys({
          action: "delete",
          id: keyId,
        });
        return {
          id: keyId,
          status: "deleted",
        };
      });
    });

  return account;
}
