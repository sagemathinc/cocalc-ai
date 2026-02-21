/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import { durationToMs } from "../../core/utils";

type BrowserSessionClient = {
  getExecApiDeclaration: () => Promise<string>;
  startExec: (opts: {
    project_id: string;
    code: string;
  }) => Promise<{ exec_id: string; status: BrowserExecStatus }>;
  getExec: (opts: {
    exec_id: string;
  }) => Promise<BrowserExecOperation>;
  cancelExec: (opts: {
    exec_id: string;
  }) => Promise<{ ok: true; exec_id: string; status: BrowserExecStatus }>;
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

type BrowserExecStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

type BrowserExecOperation = {
  exec_id: string;
  project_id: string;
  status: BrowserExecStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancel_requested?: boolean;
  error?: string;
  result?: unknown;
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

function isExecTerminal(status: BrowserExecStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

async function waitForExecOperation({
  browserClient,
  exec_id,
  pollMs,
  timeoutMs,
}: {
  browserClient: BrowserSessionClient;
  exec_id: string;
  pollMs: number;
  timeoutMs: number;
}): Promise<BrowserExecOperation> {
  const started = Date.now();
  for (;;) {
    const op = await browserClient.getExec({ exec_id });
    if (isExecTerminal(op.status)) {
      return op;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for browser exec ${exec_id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function readExecScriptFromStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
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
    .command("exec-api")
    .description(
      "print the TypeScript declaration for the browser exec API supported by the selected browser session",
    )
    .option("--browser <id>", "browser id (or unique prefix)")
    .action(async (opts: { browser?: string }, command: Command) => {
      await deps.withContext(command, "browser exec-api", async (ctx) => {
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
        return await browserClient.getExecApiDeclaration();
      });
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
    .command("exec <workspace> [code...]")
    .description(
      "execute javascript in the target browser session with a limited browser API (use 'cocalc browser exec-api' to inspect the API); provide code inline, with --file, or with --stdin",
    )
    .option("--browser <id>", "browser id (or unique prefix)")
    .option(
      "--file <path>",
      "read javascript from a file path (use '-' to read from stdin)",
    )
    .option("--stdin", "read javascript from stdin")
    .option(
      "--async",
      "start execution asynchronously and return an exec id",
    )
    .option(
      "--wait",
      "when used with --async, wait for completion and return final status/result",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval for async wait mode (e.g. 250ms, 2s)",
      "1s",
    )
    .option(
      "--timeout <duration>",
      "timeout for synchronous exec, or total wait timeout in async wait mode (e.g. 30s, 5m, 1h)",
    )
    .action(
      async (
        workspace: string,
        code: string[],
        opts: {
          browser?: string;
          file?: string;
          stdin?: boolean;
          timeout?: string;
          async?: boolean;
          wait?: boolean;
          pollMs?: string;
        },
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
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const inlineScript = (code ?? []).join(" ").trim();
          const filePath = `${opts.file ?? ""}`.trim();
          const readFromStdin = !!opts.stdin || filePath === "-";
          const readFromFile = filePath.length > 0 && filePath !== "-";
          const sourceCount =
            (inlineScript.length > 0 ? 1 : 0) +
            (readFromFile ? 1 : 0) +
            (readFromStdin ? 1 : 0);
          if (sourceCount === 0) {
            throw new Error(
              "javascript code must be provided inline, with --file <path>, or with --stdin",
            );
          }
          if (sourceCount > 1) {
            throw new Error(
              "choose exactly one script source: inline code, --file <path>, or --stdin",
            );
          }
          const script = readFromFile
            ? await readFile(filePath, "utf8")
            : readFromStdin
              ? await readExecScriptFromStdin()
              : inlineScript;
          if (!script) {
            throw new Error("javascript code must be specified");
          }
          if (opts.async) {
            const started = await browserClient.startExec({
              project_id: workspaceRow.project_id,
              code: script,
            });
            if (!opts.wait) {
              return {
                browser_id: sessionInfo.browser_id,
                project_id: workspaceRow.project_id,
                ...started,
              };
            }
            const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
            const op = await waitForExecOperation({
              browserClient,
              exec_id: started.exec_id,
              pollMs,
              timeoutMs,
            });
            if (op.status === "failed") {
              throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
            }
            if (op.status === "canceled") {
              throw new Error(`browser exec ${op.exec_id} was canceled`);
            }
            return {
              browser_id: sessionInfo.browser_id,
              ...op,
            };
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

  browser
    .command("exec-get <exec_id>")
    .description("get status/result for an async browser exec operation")
    .option("--browser <id>", "browser id (or unique prefix)")
    .option(
      "--timeout <duration>",
      "rpc timeout per status request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: { browser?: string; timeout?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-get", async (ctx) => {
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
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const op = await browserClient.getExec({ exec_id });
          return {
            browser_id: sessionInfo.browser_id,
            ...op,
          };
        });
      },
    );

  browser
    .command("exec-wait <exec_id>")
    .description("wait for completion of an async browser exec operation")
    .option("--browser <id>", "browser id (or unique prefix)")
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 250ms, 2s)",
      "1s",
    )
    .option(
      "--timeout <duration>",
      "maximum total wait duration (e.g. 30s, 5m, 1h)",
    )
    .action(
      async (
        exec_id: string,
        opts: { browser?: string; pollMs?: string; timeout?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-wait", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: opts.browser,
            fallbackBrowserId: profileSelection.browser_id,
          });
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const op = await waitForExecOperation({
            browserClient,
            exec_id,
            pollMs,
            timeoutMs,
          });
          if (op.status === "failed") {
            throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
          }
          if (op.status === "canceled") {
            throw new Error(`browser exec ${op.exec_id} was canceled`);
          }
          return {
            browser_id: sessionInfo.browser_id,
            ...op,
          };
        });
      },
    );

  browser
    .command("exec-cancel <exec_id>")
    .description("request cancellation of an async browser exec operation")
    .option("--browser <id>", "browser id (or unique prefix)")
    .option(
      "--timeout <duration>",
      "rpc timeout for cancel request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: { browser?: string; timeout?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-cancel", async (ctx) => {
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
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const canceled = await browserClient.cancelExec({ exec_id });
          return {
            browser_id: sessionInfo.browser_id,
            ...canceled,
          };
        });
      },
    );

  return browser;
}
