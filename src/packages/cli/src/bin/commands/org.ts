import { Command } from "commander";

export type OrgCommandDeps = {
  withContext: any;
};

export function registerOrgCommand(program: Command, deps: OrgCommandDeps): Command {
  const { withContext } = deps;

  const org = program.command("org").description("organization operations");
  const orgToken = org.command("token").description("organization user auth tokens");

  orgToken
    .command("create")
    .description("create an organization-scoped impersonation token for a user")
    .requiredOption(
      "--user <user>",
      "user account id or email (must be in an organization you administer)",
    )
    .option("--expire-seconds <n>", "expire in n seconds")
    .action(
      async (
        opts: {
          user: string;
          expireSeconds?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "org token create", async (ctx) => {
          const user = `${opts.user ?? ""}`.trim();
          if (!user) {
            throw new Error("--user is required");
          }
          const expireSeconds =
            opts.expireSeconds == null ? undefined : Number(opts.expireSeconds);
          if (
            expireSeconds != null &&
            (!Number.isFinite(expireSeconds) || expireSeconds <= 0)
          ) {
            throw new Error("--expire-seconds must be a positive number");
          }
          const expire =
            expireSeconds == null ? undefined : Date.now() + expireSeconds * 1000;

          const issued = await ctx.hub.org.createToken({
            user,
            ...(expire == null ? {} : { expire }),
          });
          return {
            user,
            token: issued.token,
            url: issued.url,
            expire,
          };
        });
      },
    );

  orgToken
    .command("expire")
    .description("expire/revoke an organization impersonation token")
    .requiredOption("--token <token>", "token to revoke")
    .action(
      async (
        opts: {
          token: string;
        },
        command: Command,
      ) => {
        await withContext(command, "org token expire", async (ctx) => {
          const token = `${opts.token ?? ""}`.trim();
          if (!token) {
            throw new Error("--token is required");
          }
          await ctx.hub.org.expireToken({ token });
          return {
            token,
            status: "expired",
          };
        });
      },
    );

  return org;
}

