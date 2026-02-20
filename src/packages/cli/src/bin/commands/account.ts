import { Command } from "commander";

export type AccountCommandDeps = {
  withContext: any;
  toIso: any;
};

export function registerAccountCommand(program: Command, deps: AccountCommandDeps): Command {
  const { withContext, toIso } = deps;

  const account = program.command("account").description("account operations");
  const accountApiKey = account.command("api-key").description("manage account API keys");

  accountApiKey
    .command("list")
    .description("list account API keys")
    .action(async (command: Command) => {
      await withContext(command, "account api-key list", async (ctx) => {
        const rows = (await ctx.hub.system.manageApiKeys({
          action: "get",
        })) as Array<{
          id?: number;
          name?: string;
          trunc?: string;
          created?: string | Date | null;
          expire?: string | Date | null;
          last_active?: string | Date | null;
          project_id?: string | null;
        }>;
        return (rows ?? []).map((row) => ({
          id: row.id,
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
    .option("--name <name>", "key label", `cocalc-cli-${Date.now().toString(36)}`)
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
