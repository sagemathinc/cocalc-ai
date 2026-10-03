import type { HubApi } from "@cocalc/conat/hub/api";
import { isValidUUID } from "@cocalc/util/misc";
import { parsePersonalUrl } from "@cocalc/util/personal-urls";
import { Command } from "commander";

export type PersonalUrlsCommandDeps = {
  withContext: (
    command: Command,
    label: string,
    fn: (ctx: { hub: Pick<HubApi, "personalUrls"> }) => Promise<unknown>,
  ) => Promise<void>;
};

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function ownerAccountId(value: string): string {
  const id = value.trim();
  if (!isValidUUID(id)) throw new Error("owner_account_id must be a UUID");
  return id;
}

export function registerUrlCommand(
  program: Command,
  { withContext }: PersonalUrlsCommandDeps,
): Command {
  const url = program
    .command("url")
    .description("resolve personal URLs without opening project content");
  url
    .command("resolve <url>")
    .description(
      "resolve a personal URL to canonical owner/project/content IDs",
    )
    .option(
      "--inspect",
      "admin-only locator diagnostics; does not grant content access",
    )
    .addHelpText(
      "after",
      '\nUses the configured API/profile, never the input URL\'s host. Resolution does not start a project or grant content access.\n\nProject links (/u/<owner>/projects/<alias>/...) return target.project_id plus `location`, the decoded thing the link opens, e.g. /u/alice/projects/thesis/files/home/user/a.md gives { kind: "file", path: "/home/user/a.md" }. Use those with the project file commands.\n',
    )
    .action(
      async (value: string, opts: { inspect?: boolean }, command: Command) => {
        await withContext(command, "url resolve", async ({ hub }) => {
          // Treat the URL as data, not as a transport or credential destination.
          const input = requiredText(value, "URL");
          parsePersonalUrl(input);
          return await hub.personalUrls.resolveUrl({
            url: input,
            ...(opts.inspect ? { inspect: true } : {}),
          });
        });
      },
    );
  return url;
}

export function registerAccountUsernameCommand(
  account: Command,
  { withContext }: PersonalUrlsCommandDeps,
): Command {
  const username = account
    .command("username")
    .description("manage your personal URL username and inspect redirects");
  username
    .command("get")
    .description("show your current username and retained redirects")
    .action(async (_opts, command: Command) => {
      await withContext(command, "account username get", async ({ hub }) => {
        return await hub.personalUrls.getUsername({});
      });
    });
  username
    .command("set <username>")
    .description(
      "set your personal URL username (server validates availability)",
    )
    .action(async (value: string, _opts, command: Command) => {
      await withContext(command, "account username set", async ({ hub }) => {
        return await hub.personalUrls.setUsername({
          username: requiredText(value, "username"),
        });
      });
    });
  username
    .command("clear")
    .description(
      "clear your current username; retained redirects remain reserved",
    )
    .action(async (_opts, command: Command) => {
      await withContext(command, "account username clear", async ({ hub }) => {
        return await hub.personalUrls.setUsername({ username: null });
      });
    });
  return username;
}

export function registerAdminUsernameCommand(
  admin: Command,
  { withContext }: PersonalUrlsCommandDeps,
): Command {
  const username = admin
    .command("username")
    .description("admin personal URL username and redirect operations");
  username
    .command("inspect <owner_account_id>")
    .description("show an account's current username and retained redirects")
    .action(async (owner: string, _opts, command: Command) => {
      await withContext(command, "admin username inspect", async ({ hub }) => {
        return await hub.personalUrls.getUsername({
          owner_account_id: ownerAccountId(owner),
        });
      });
    });
  username
    .command("release-redirect <owner_account_id> <username>")
    .description("release a retained username redirect (admin fresh-auth)")
    .requiredOption("--reason <text>", "operator audit reason")
    .option("--yes", "confirm releasing this redirect for reuse")
    .action(
      async (
        owner: string,
        value: string,
        opts: { reason: string; yes?: boolean },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin username release-redirect",
          async ({ hub }) => {
            if (!opts.yes) {
              throw new Error("pass --yes to confirm releasing this redirect");
            }
            const request = {
              owner_account_id: ownerAccountId(owner),
              username: requiredText(value, "username"),
              reason: requiredText(opts.reason, "reason"),
            };
            await hub.personalUrls.releaseRedirect(request);
            return {
              owner_account_id: request.owner_account_id,
              username: request.username,
              released: true,
            };
          },
        );
      },
    );
  return username;
}
