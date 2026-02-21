/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";

type BrowserSessionClient = {
  listOpenFiles: () => Promise<
    {
      project_id: string;
      title?: string;
      path: string;
    }[]
  >;
  openFile: (opts: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
  }) => Promise<{ ok: true }>;
  closeFile: (opts: {
    project_id: string;
    path: string;
  }) => Promise<{ ok: true }>;
  exec: (opts: {
    project_id: string;
    code: string;
  }) => Promise<{ ok: true; result: unknown }>;
};

export type BrowserCommandDeps = {
  withContext: any;
  authConfigPath: any;
  loadAuthConfig: any;
  saveAuthConfig: any;
  selectedProfileName: any;
  globalsFrom: any;
  resolveWorkspace: any;
  createBrowserSessionClient: any;
};

function normalizeBrowserId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id.length > 0 ? id : undefined;
}

function resolveBrowserSession(
  sessions: BrowserSessionInfo[],
  browserHint: string,
): BrowserSessionInfo {
  const exact = sessions.find((s) => s.browser_id === browserHint);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.browser_id.startsWith(browserHint));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(
      `browser id '${browserHint}' is ambiguous (${prefixed.length} matches)`,
    );
  }
  throw new Error(`browser session '${browserHint}' not found`);
}

function loadProfileSelection(
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >,
  command: Command,
): {
  path: string;
  config: any;
  profile: string;
  browser_id?: string;
} {
  const globals = deps.globalsFrom(command);
  const path = deps.authConfigPath(process.env);
  const config = deps.loadAuthConfig(path);
  const profile = deps.selectedProfileName(globals, config, process.env);
  const browser_id = normalizeBrowserId(config?.profiles?.[profile]?.browser_id);
  return { path, config, profile, browser_id };
}

function saveProfileBrowserId({
  deps,
  command,
  browser_id,
}: {
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >;
  command: Command;
  browser_id?: string;
}): { profile: string; browser_id?: string } {
  const { path, config, profile } = loadProfileSelection(deps, command);
  const profileData = { ...(config.profiles?.[profile] ?? {}) };
  if (browser_id) {
    profileData.browser_id = browser_id;
  } else {
    delete profileData.browser_id;
  }
  config.current_profile = profile;
  config.profiles = config.profiles ?? {};
  config.profiles[profile] = profileData;
  deps.saveAuthConfig(config, path);
  return { profile, browser_id };
}

async function chooseBrowserSession({
  ctx,
  browserHint,
  fallbackBrowserId,
}: {
  ctx: any;
  browserHint?: string;
  fallbackBrowserId?: string;
}): Promise<BrowserSessionInfo> {
  const sessions = (await ctx.hub.system.listBrowserSessions({
    include_stale: true,
  })) as BrowserSessionInfo[];
  const explicitHint = normalizeBrowserId(browserHint);
  if (explicitHint) {
    return resolveBrowserSession(sessions, explicitHint);
  }
  const savedHint = normalizeBrowserId(fallbackBrowserId);
  if (savedHint) {
    const saved = resolveBrowserSession(sessions, savedHint);
    if (!saved.stale) {
      return saved;
    }
  }
  const active = sessions.filter((s) => !s.stale);
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) {
    throw new Error(
      "no active browser sessions found; open CoCalc in a browser first",
    );
  }
  throw new Error(
    `multiple active browser sessions found (${active.length}); use --browser <id> or 'cocalc browser session use <id>'`,
  );
}

export function registerBrowserCommand(
  program: Command,
  deps: BrowserCommandDeps,
): Command {
  const browser = program
    .command("browser")
    .description("browser session discovery and automation");

  const session = browser.command("session").description("browser sessions");

  session
    .command("list")
    .description("list browser sessions for the signed-in account")
    .option("--include-stale", "include stale/inactive sessions")
    .option(
      "--max-age-ms <ms>",
      "consider session stale if heartbeat is older than this",
      "120000",
    )
    .action(
      async (
        opts: { includeStale?: boolean; maxAgeMs?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser session list", async (ctx) => {
          const maxAgeMs = Number(opts.maxAgeMs ?? "120000");
          if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
            throw new Error("--max-age-ms must be a positive number");
          }
          const sessions = (await ctx.hub.system.listBrowserSessions({
            include_stale: !!opts.includeStale,
            max_age_ms: Math.floor(maxAgeMs),
          })) as BrowserSessionInfo[];
          return sessions.map((s) => ({
            browser_id: s.browser_id,
            session_name: s.session_name ?? "",
            active_project_id: s.active_project_id ?? "",
            open_projects: s.open_projects?.length ?? 0,
            stale: !!s.stale,
            updated_at: s.updated_at,
            created_at: s.created_at,
            url: s.url ?? "",
          }));
        });
      },
    );

  session
    .command("use <browser>")
    .description("set default browser session id for the current auth profile")
    .action(async (browserHint: string, command: Command) => {
      await deps.withContext(command, "browser session use", async (ctx) => {
        const sessions = (await ctx.hub.system.listBrowserSessions({
          include_stale: true,
        })) as BrowserSessionInfo[];
        const selected = resolveBrowserSession(sessions, browserHint);
        const saved = saveProfileBrowserId({
          deps,
          command,
          browser_id: selected.browser_id,
        });
        return {
          profile: saved.profile,
          browser_id: selected.browser_id,
          stale: !!selected.stale,
        };
      });
    });

  session
    .command("clear")
    .description("clear default browser session id for current auth profile")
    .action(async (_opts: unknown, command: Command) => {
      const saved = saveProfileBrowserId({
        deps,
        command,
        browser_id: undefined,
      });
      await deps.withContext(command, "browser session clear", async () => ({
        profile: saved.profile,
        browser_id: null,
      }));
    });

  browser
    .command("files")
    .description("list files currently open in a browser session")
    .option("--browser <id>", "browser id (or unique prefix)")
    .action(async (opts: { browser?: string }, command: Command) => {
      await deps.withContext(command, "browser files", async (ctx) => {
        const profileSelection = loadProfileSelection(deps, command);
        const sessionInfo = await chooseBrowserSession({
          ctx,
          browserHint: opts.browser,
          fallbackBrowserId: profileSelection.browser_id,
        });
        const browserClient = deps.createBrowserSessionClient({
          account_id: ctx.accountId,
          browser_id: sessionInfo.browser_id,
          client: ctx.remote.client,
        }) as BrowserSessionClient;
        const files = await browserClient.listOpenFiles();
        return files.map((row) => ({
          browser_id: sessionInfo.browser_id,
          project_id: row.project_id,
          title: row.title ?? "",
          path: row.path,
        }));
      });
    });

  browser
    .command("open <workspace> <paths...>")
    .description("open one or more workspace files in a target browser session")
    .option("--browser <id>", "browser id (or unique prefix)")
    .option(
      "--background",
      "open in background (do not focus project/file in browser)",
    )
    .action(
      async (
        workspace: string,
        paths: string[],
        opts: { browser?: string; background?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "browser open", async (ctx) => {
          const workspaceRow = await deps.resolveWorkspace(ctx, workspace);
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: opts.browser,
            fallbackBrowserId: profileSelection.browser_id,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const cleanPaths = (paths ?? []).map((p) => `${p ?? ""}`.trim()).filter((p) => p.length > 0);
          if (!cleanPaths.length) {
            throw new Error("at least one path must be specified");
          }
          for (const [index, path] of cleanPaths.entries()) {
            const foreground = !opts.background && index === 0;
            await browserClient.openFile({
              project_id: workspaceRow.project_id,
              path,
              foreground,
              foreground_project: foreground,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id: workspaceRow.project_id,
            paths: cleanPaths,
            opened: cleanPaths.length,
            background: !!opts.background,
          };
        });
      },
    );

  browser
    .command("close <workspace> <paths...>")
    .description("close one or more open workspace files in a target browser session")
    .option("--browser <id>", "browser id (or unique prefix)")
    .action(
      async (
        workspace: string,
        paths: string[],
        opts: { browser?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser close", async (ctx) => {
          const workspaceRow = await deps.resolveWorkspace(ctx, workspace);
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: opts.browser,
            fallbackBrowserId: profileSelection.browser_id,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const cleanPaths = (paths ?? []).map((p) => `${p ?? ""}`.trim()).filter((p) => p.length > 0);
          if (!cleanPaths.length) {
            throw new Error("at least one path must be specified");
          }
          for (const path of cleanPaths) {
            await browserClient.closeFile({
              project_id: workspaceRow.project_id,
              path,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id: workspaceRow.project_id,
            paths: cleanPaths,
            closed: cleanPaths.length,
          };
        });
      },
    );

  browser
    .command("exec <workspace> <code...>")
    .description(
      "execute javascript in the target browser session with a limited browser API",
    )
    .option("--browser <id>", "browser id (or unique prefix)")
    .action(
      async (
        workspace: string,
        code: string[],
        opts: { browser?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec", async (ctx) => {
          const workspaceRow = await deps.resolveWorkspace(ctx, workspace);
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: opts.browser,
            fallbackBrowserId: profileSelection.browser_id,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const script = (code ?? []).join(" ").trim();
          if (!script) {
            throw new Error("javascript code must be specified");
          }
          const response = await browserClient.exec({
            project_id: workspaceRow.project_id,
            code: script,
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id: workspaceRow.project_id,
            ok: !!response?.ok,
            result: response?.result ?? null,
          };
        });
      },
    );

  return browser;
}
