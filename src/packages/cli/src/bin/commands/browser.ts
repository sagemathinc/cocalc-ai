/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import { isValidUUID } from "@cocalc/util/misc";
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

function browserHintFromOption(value: unknown): string | undefined {
  return (
    normalizeBrowserId(value) ?? normalizeBrowserId(process.env.COCALC_BROWSER_ID)
  );
}

function isLikelyExactBrowserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(value);
}

function directBrowserSessionInfo(browser_id: string): BrowserSessionInfo {
  const now = new Date().toISOString();
  return {
    browser_id,
    open_projects: [],
    stale: false,
    created_at: now,
    updated_at: now,
  };
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

function sessionMatchesProject(
  session: BrowserSessionInfo,
  projectId: string | undefined,
): boolean {
  const target = `${projectId ?? ""}`.trim();
  if (!target) return true;
  if (`${session.active_project_id ?? ""}`.trim() === target) {
    return true;
  }
  return (session.open_projects ?? []).some(
    (p) => `${p?.project_id ?? ""}`.trim() === target,
  );
}

function sessionTargetContext(
  ctx: any,
  sessionInfo: BrowserSessionInfo,
  project_id?: string,
): Record<string, unknown> {
  const apiUrl = `${ctx?.apiBaseUrl ?? ""}`.trim();
  const sessionUrl = `${sessionInfo?.url ?? ""}`.trim();
  let target_warning = "";
  if (apiUrl && sessionUrl) {
    try {
      const apiOrigin = new URL(apiUrl).origin;
      const sessionOrigin = new URL(sessionUrl).origin;
      if (apiOrigin !== sessionOrigin) {
        target_warning =
          `browser session URL origin (${sessionOrigin}) differs from API origin (${apiOrigin})`;
      }
    } catch {
      // ignore parse failures
    }
  }
  return {
    target_api_url: apiUrl,
    target_browser_id: sessionInfo.browser_id,
    target_session_url: sessionUrl,
    ...(project_id ? { target_project_id: project_id } : {}),
    ...(target_warning ? { target_warning } : {}),
  };
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
  requireDiscovery = false,
  sessionProjectId,
  activeOnly = false,
}: {
  ctx: any;
  browserHint?: string;
  fallbackBrowserId?: string;
  requireDiscovery?: boolean;
  sessionProjectId?: string;
  activeOnly?: boolean;
}): Promise<BrowserSessionInfo> {
  let sessions: BrowserSessionInfo[] | undefined;
  const getSessions = async (): Promise<BrowserSessionInfo[]> => {
    if (sessions) return sessions;
    sessions = (await ctx.hub.system.listBrowserSessions({
      include_stale: !activeOnly,
    })) as BrowserSessionInfo[];
    sessions = (sessions ?? []).filter((s) =>
      activeOnly ? !s.stale : true,
    );
    sessions = sessions.filter((s) => sessionMatchesProject(s, sessionProjectId));
    return sessions;
  };

  const explicitHint = normalizeBrowserId(browserHint);
  if (
    explicitHint &&
    !requireDiscovery &&
    isLikelyExactBrowserId(explicitHint) &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim()
  ) {
    return directBrowserSessionInfo(explicitHint);
  }
  if (explicitHint) {
    return resolveBrowserSession(await getSessions(), explicitHint);
  }
  const savedHint = normalizeBrowserId(fallbackBrowserId);
  if (
    savedHint &&
    !requireDiscovery &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim()
  ) {
    return directBrowserSessionInfo(savedHint);
  }
  const resolvedSessions = await getSessions();
  if (savedHint) {
    const saved = resolveBrowserSession(resolvedSessions, savedHint);
    if (!saved.stale) {
      return saved;
    }
  }
  const active = resolvedSessions.filter((s) => !s.stale);
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) {
    if (`${sessionProjectId ?? ""}`.trim()) {
      throw new Error(
        `no active browser sessions found for project '${sessionProjectId}'`,
      );
    }
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

function browserScreenshotScript({
  selector,
  scale,
  waitForIdleMs,
}: {
  selector: string;
  scale: number;
  waitForIdleMs: number;
}): string {
  return `
const selector = ${JSON.stringify(selector)};
const scale = ${JSON.stringify(scale)};
const waitForIdleMs = ${JSON.stringify(waitForIdleMs)};
const libraryUrls = [
  "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
];
const loadScript = async (url) => {
  await new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll("script")).find(
      (s) => s.src === url,
    );
    if (existing && (window).html2canvas) {
      resolve(undefined);
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error(\`timed out loading \${url}\`)),
      15000,
    );
    script.onload = () => resolve(undefined);
    script.onerror = () => reject(new Error(\`failed to load \${url}\`));
    script.onload = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error(\`failed to load \${url}\`));
    };
    document.head.appendChild(script);
  });
};
const waitForDomIdle = async (idleMs) => {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false;
  const maxWaitMs = Math.max(1000, Math.min(30000, Math.floor(idleMs * 20)));
  const timedOut = await new Promise((resolve) => {
    let timer = undefined;
    let maxTimer = undefined;
    let done = false;
    const finish = (maxedOut) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      observer.disconnect();
      resolve(!!maxedOut);
    };
    const schedule = () => {
      if (done) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(false), idleMs);
    };
    const root = document.documentElement || document.body;
    const observer = new MutationObserver(() => {
      schedule();
    });
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    maxTimer = setTimeout(() => finish(true), maxWaitMs);
    schedule();
  });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
  );
  return timedOut;
};
let html2canvas = (window).html2canvas;
if (typeof html2canvas !== "function") {
  let lastError = "";
  for (const url of libraryUrls) {
    try {
      await loadScript(url);
      html2canvas = (window).html2canvas;
      if (typeof html2canvas === "function") break;
    } catch (err) {
      lastError = \`\${err}\`;
    }
  }
  if (typeof html2canvas !== "function") {
    throw new Error(
      \`unable to initialize screenshot renderer (html2canvas): \${lastError || "library unavailable"}\`,
    );
  }
}
const root = document.querySelector(selector);
if (!root) {
  throw new Error(\`selector did not match any element: \${selector}\`);
}
const wait_for_idle_timed_out = await waitForDomIdle(waitForIdleMs);
const canvas = await html2canvas(root, {
  scale,
  useCORS: true,
  allowTaint: true,
  backgroundColor: null,
  logging: false,
});
if (!canvas || typeof canvas.toDataURL !== "function") {
  throw new Error("screenshot renderer did not return a canvas");
}
const png_data_url = canvas.toDataURL("image/png");
if (typeof png_data_url !== "string" || !png_data_url.startsWith("data:image/png;base64,")) {
  throw new Error("invalid PNG data returned by screenshot renderer");
}
return {
  ok: true,
  selector,
  width: Number(canvas.width || 0),
  height: Number(canvas.height || 0),
  page_url: location.href,
  wait_for_idle_ms: waitForIdleMs,
  wait_for_idle_timed_out,
  png_data_url,
};
`.trim();
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
    .option("--active-only", "include only active sessions")
    .option(
      "--project-id <id>",
      "filter to sessions targeting this active/open workspace/project id",
    )
    .option(
      "--max-age-ms <ms>",
      "consider session stale if heartbeat is older than this",
      "120000",
    )
    .action(
      async (
        opts: {
          includeStale?: boolean;
          activeOnly?: boolean;
          projectId?: string;
          maxAgeMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser session list", async (ctx) => {
          const maxAgeMs = Number(opts.maxAgeMs ?? "120000");
          if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
            throw new Error("--max-age-ms must be a positive number");
          }
          if (opts.includeStale && opts.activeOnly) {
            throw new Error("--include-stale and --active-only cannot both be set");
          }
          const projectId = `${opts.projectId ?? ""}`.trim();
          const sessions = (await ctx.hub.system.listBrowserSessions({
            include_stale: opts.activeOnly ? false : !!opts.includeStale,
            max_age_ms: Math.floor(maxAgeMs),
          })) as BrowserSessionInfo[];
          return (sessions ?? [])
            .filter((s) => (opts.activeOnly ? !s.stale : true))
            .filter((s) => sessionMatchesProject(s, projectId))
            .map((s) => ({
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
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: { browser?: string; sessionProjectId?: string; activeOnly?: boolean },
        command: Command,
      ) => {
      await deps.withContext(command, "browser exec-api", async (ctx) => {
        const profileSelection = loadProfileSelection(deps, command);
        const sessionInfo = await chooseBrowserSession({
          ctx,
          browserHint: browserHintFromOption(opts.browser),
          fallbackBrowserId: profileSelection.browser_id,
          sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
          activeOnly: !!opts.activeOnly,
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
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: { browser?: string; sessionProjectId?: string; activeOnly?: boolean },
        command: Command,
      ) => {
      await deps.withContext(command, "browser files", async (ctx) => {
        const profileSelection = loadProfileSelection(deps, command);
        const sessionInfo = await chooseBrowserSession({
          ctx,
          browserHint: browserHintFromOption(opts.browser),
          fallbackBrowserId: profileSelection.browser_id,
          sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
          activeOnly: !!opts.activeOnly,
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
          ...sessionTargetContext(ctx, sessionInfo, row.project_id),
        }));
      });
    });

  browser
    .command("open [workspace] <paths...>")
    .description(
      "open one or more workspace files in a target browser session (supports --project-id/COCALC_PROJECT_ID)",
    )
    .option(
      "--project-id <id>",
      "workspace/project id (overrides [workspace]); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--background",
      "open in background (do not focus project/file in browser)",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        workspace: string | undefined,
        paths: string[],
        opts: {
          browser?: string;
          projectId?: string;
          background?: boolean;
          sessionProjectId?: string;
          activeOnly?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser open", async (ctx) => {
          const projectHint = `${opts.projectId ?? workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          if (!projectHint) {
            throw new Error(
              "workspace/project is required; pass [workspace], --project-id, or set COCALC_PROJECT_ID",
            );
          }
          const project_id = isValidUUID(projectHint)
            ? projectHint
            : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const profileSelection = loadProfileSelection(deps, command);
          const browserHint = browserHintFromOption(opts.browser);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project_id,
            activeOnly: !!opts.activeOnly,
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
              project_id,
              path,
              foreground,
              foreground_project: foreground,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            paths: cleanPaths,
            opened: cleanPaths.length,
            background: !!opts.background,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("close [workspace] <paths...>")
    .description(
      "close one or more open workspace files in a target browser session (supports --project-id/COCALC_PROJECT_ID)",
    )
    .option(
      "--project-id <id>",
      "workspace/project id (overrides [workspace]); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        workspace: string | undefined,
        paths: string[],
        opts: {
          browser?: string;
          projectId?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser close", async (ctx) => {
          const projectHint = `${opts.projectId ?? workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          if (!projectHint) {
            throw new Error(
              "workspace/project is required; pass [workspace], --project-id, or set COCALC_PROJECT_ID",
            );
          }
          const project_id = isValidUUID(projectHint)
            ? projectHint
            : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const profileSelection = loadProfileSelection(deps, command);
          const browserHint = browserHintFromOption(opts.browser);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project_id,
            activeOnly: !!opts.activeOnly,
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
              project_id,
              path,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            paths: cleanPaths,
            closed: cleanPaths.length,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("screenshot")
    .description(
      "capture a PNG screenshot from a target browser session and save it locally",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--selector <css>",
      "CSS selector for screenshot root element",
      "body",
    )
    .option(
      "--scale <n>",
      "render scale for screenshot capture",
      "1",
    )
    .option("--out <path>", "output PNG path on local machine")
    .option(
      "--timeout <duration>",
      "timeout for screenshot capture (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-idle <duration>",
      "wait for DOM idle before capture (e.g. 250ms, 2s)",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          selector?: string;
          scale?: string;
          out?: string;
          timeout?: string;
          waitForIdle?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser screenshot", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = projectIdHint
            ? projectIdHint
            : workspaceHint
              ? (await deps.resolveWorkspace(ctx, workspaceHint)).project_id
              : sessionInfo.active_project_id
                ? (await deps.resolveWorkspace(ctx, sessionInfo.active_project_id)).project_id
                : sessionInfo.open_projects?.length === 1 &&
                    sessionInfo.open_projects[0]?.project_id
                  ? (
                      await deps.resolveWorkspace(
                        ctx,
                        sessionInfo.open_projects[0].project_id,
                      )
                    ).project_id
                  : (() => {
                      throw new Error(
                        "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
                      );
                    })();

          const selector = `${opts.selector ?? "body"}`.trim() || "body";
          const scale = Number(opts.scale ?? "1");
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error("--scale must be a positive number");
          }
          const waitForIdleMs = `${opts.waitForIdle ?? ""}`.trim()
            ? Math.max(0, durationToMs(opts.waitForIdle, 1_000))
            : 0;
          const outputPath =
            `${opts.out ?? ""}`.trim() ||
            `browser-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const started = await browserClient.startExec({
            project_id,
            code: browserScreenshotScript({ selector, scale, waitForIdleMs }),
          });
          const op = await waitForExecOperation({
            browserClient,
            exec_id: started.exec_id,
            pollMs: 1_000,
            timeoutMs,
          });
          if (op.status === "failed") {
            throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
          }
          if (op.status === "canceled") {
            throw new Error(`browser exec ${op.exec_id} was canceled`);
          }
          const result = (op?.result ?? {}) as any;
          const pngDataUrl = `${result?.png_data_url ?? ""}`.trim();
          if (!pngDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("browser screenshot capture returned invalid PNG data");
          }
          const base64 = pngDataUrl.slice("data:image/png;base64,".length);
          const png = Buffer.from(base64, "base64");
          await writeFile(outputPath, png);

          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            output_path: resolvePath(outputPath),
            bytes: png.byteLength,
            width: Number(result?.width ?? 0),
            height: Number(result?.height ?? 0),
            selector,
            wait_for_idle_ms: Number(result?.wait_for_idle_ms ?? waitForIdleMs),
            wait_for_idle_timed_out: !!result?.wait_for_idle_timed_out,
            page_url: `${result?.page_url ?? ""}`,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("exec [code...]")
    .description(
      "execute javascript in the target browser session with a limited browser API (use 'cocalc browser exec-api' to inspect the API); provide code inline, with --file, or with --stdin",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
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
        code: string[],
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
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
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = projectIdHint
            ? projectIdHint
            : workspaceHint
              ? (await deps.resolveWorkspace(ctx, workspaceHint)).project_id
              : sessionInfo.active_project_id
                ? (await deps.resolveWorkspace(ctx, sessionInfo.active_project_id)).project_id
                : sessionInfo.open_projects?.length === 1 &&
                    sessionInfo.open_projects[0]?.project_id
                  ? (
                      await deps.resolveWorkspace(
                        ctx,
                        sessionInfo.open_projects[0].project_id,
                      )
                    ).project_id
                  : (() => {
                      throw new Error(
                        "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
                      );
                    })();
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
              project_id,
              code: script,
            });
            if (!opts.wait) {
              return {
                browser_id: sessionInfo.browser_id,
                project_id,
                ...started,
                ...sessionTargetContext(ctx, sessionInfo, project_id),
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
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          }
          const response = await browserClient.exec({
            project_id,
            code: script,
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("exec-get <exec_id>")
    .description("get status/result for an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--timeout <duration>",
      "rpc timeout per status request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-get", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
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
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  browser
    .command("exec-wait <exec_id>")
    .description("wait for completion of an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
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
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-wait", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
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
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  browser
    .command("exec-cancel <exec_id>")
    .description("request cancellation of an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--timeout <duration>",
      "rpc timeout for cancel request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-cancel", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
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
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  return browser;
}
