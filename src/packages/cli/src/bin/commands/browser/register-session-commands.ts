/*
Register `cocalc browser session ...` subcommands.
*/

import { Command } from "commander";
import type {
  BrowserCommandDeps,
  BrowserSessionRegisterUtils,
  SpawnStateRecord,
} from "./types";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";

type RegisterSessionDeps = {
  browser: Command;
  deps: BrowserCommandDeps;
  utils: BrowserSessionRegisterUtils;
};

export function registerBrowserSessionCommands({
  browser,
  deps,
  utils,
}: RegisterSessionDeps): void {
  const {
    loadProfileSelection,
    saveProfileBrowserId,
    resolveBrowserSession,
    randomSpawnId,
    spawnStateFile,
    readSpawnState,
    isProcessRunning,
    resolveSpawnTargetUrl,
    withSpawnMarker,
    resolveChromiumExecutablePath,
    resolveSecret,
    buildSpawnCookies,
    writeDaemonConfig,
    parseDiscoveryTimeout,
    waitForSpawnStateReady,
    waitForSpawnedSession,
    nowIso,
    terminateSpawnedProcess,
    listSpawnStates,
    resolveSpawnStateById,
    isSeaMode,
    sessionMatchesProject,
    sessionTargetContext,
    writeSpawnState,
    DEFAULT_READY_TIMEOUT_MS,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    DEFAULT_DESTROY_TIMEOUT_MS,
    SPAWN_STATE_DIR,
    spawnProcess,
    resolvePath,
    join,
    existsSync,
    unlinkSync,
    isValidUUID,
  } = utils;
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

  session
    .command("spawn")
    .description(
      "spawn a dedicated Playwright-backed Chromium browser session for automation",
    )
    .option("--api-url <url>", "CoCalc API/base URL (defaults to active CLI context)")
    .option("--target-url <url>", "exact URL to open in spawned Chromium session")
    .option("-w, --workspace <workspace>", "workspace id or name to open")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--session-name <name>",
      "set document.title for easier identification in browser session list",
    )
    .option(
      "--spawn-id <id>",
      "explicit spawn id (defaults to generated id)",
    )
    .option(
      "--chromium <path>",
      "explicit Chromium executable path (defaults to auto-detect from PATH)",
    )
    .option(
      "--headless",
      "launch Chromium in headless mode (default)",
    )
    .option(
      "--headed",
      "launch Chromium in visible headed mode",
    )
    .option(
      "--ready-timeout <duration>",
      "timeout for daemon startup readiness (e.g. 10s, 1m)",
      "20s",
    )
    .option(
      "--timeout <duration>",
      "timeout to discover browser heartbeat session (e.g. 30s, 2m)",
      "45s",
    )
    .option(
      "--use",
      "set discovered browser id as default for current auth profile",
    )
    .action(
      async (
        opts: {
          apiUrl?: string;
          targetUrl?: string;
          workspace?: string;
          projectId?: string;
          sessionName?: string;
          spawnId?: string;
          chromium?: string;
          headless?: boolean;
          headed?: boolean;
          readyTimeout?: string;
          timeout?: string;
          use?: boolean;
        },
        command: Command,
      ) => {
        if (isSeaMode()) {
          throw new Error(
            "browser session spawn is unsupported in standalone SEA binary; use JS CLI (e.g. node ./packages/cli/dist/bin/cocalc.js ...).",
          );
        }
        await deps.withContext(command, "browser session spawn", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const globals = deps.globalsFrom(command);
          const apiUrl = `${opts.apiUrl ?? ctx.apiBaseUrl ?? ""}`.trim();
          if (!apiUrl) {
            throw new Error("api url is required; pass --api-url or configure COCALC_API_URL");
          }
          let parsedApiUrl: string;
          try {
            parsedApiUrl = new URL(apiUrl).toString();
          } catch {
            throw new Error(`invalid --api-url '${apiUrl}'`);
          }
          const projectHint = `${opts.projectId ?? opts.workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const project_id = !projectHint
            ? undefined
            : isValidUUID(projectHint)
              ? projectHint
              : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const spawnId = `${opts.spawnId ?? ""}`.trim() || randomSpawnId();
          const stateFile = spawnStateFile(spawnId);
          const existing = readSpawnState(stateFile);
          if (existing?.pid && isProcessRunning(existing.pid)) {
            throw new Error(
              `spawn id '${spawnId}' is already active (pid ${existing.pid}); destroy it first`,
            );
          }
          const marker = `${spawnId}-${Math.random().toString(36).slice(2, 8)}`;
          const targetUrl = resolveSpawnTargetUrl({
            apiUrl: parsedApiUrl,
            projectId: project_id,
            explicitTargetUrl: opts.targetUrl,
          });
          const markedTargetUrl = withSpawnMarker(targetUrl, marker);
          const chromiumPath = resolveChromiumExecutablePath(opts.chromium);
          if (!chromiumPath) {
            throw new Error(
              "unable to find Chromium executable; pass --chromium <path> or set COCALC_CHROMIUM_BIN",
            );
          }
          const hubPassword = resolveSecret(globals.hubPassword ?? process.env.COCALC_HUB_PASSWORD);
          const apiKey = resolveSecret(globals.apiKey ?? process.env.COCALC_API_KEY);
          const cookies = buildSpawnCookies({
            apiUrl: parsedApiUrl,
            hubPassword,
            apiKey,
          });
          const sessionName =
            `${opts.sessionName ?? ""}`.trim() || `CoCalc Agent Session (${spawnId})`;
          const daemonConfigPath = join(
            SPAWN_STATE_DIR,
            `${spawnId}.config-${process.pid}-${Date.now()}.json`,
          );
          const daemonScript = resolvePath(
            __dirname,
            "..",
            "core",
            "browser-session-playwright-daemon.js",
          );
          if (!existsSync(daemonScript)) {
            throw new Error(
              `missing daemon script '${daemonScript}' (build @cocalc/cli first)`,
            );
          }
          if (opts.headless && opts.headed) {
            throw new Error("choose only one of --headless or --headed");
          }
          const spawnHeadless = opts.headed ? false : true;
          writeDaemonConfig(daemonConfigPath, {
            spawn_id: spawnId,
            state_file: stateFile,
            target_url: markedTargetUrl,
            headless: spawnHeadless,
            timeout_ms: parseDiscoveryTimeout(opts.readyTimeout, DEFAULT_READY_TIMEOUT_MS),
            executable_path: chromiumPath,
            session_name: sessionName,
            cookies,
          });
          const child = spawnProcess(process.execPath, [daemonScript, daemonConfigPath], {
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          const daemonPid = child.pid;
          if (!daemonPid || daemonPid <= 0) {
            throw new Error("failed to start browser spawn daemon");
          }

          try {
            await waitForSpawnStateReady({
              stateFile,
              timeoutMs: parseDiscoveryTimeout(
                opts.readyTimeout,
                DEFAULT_READY_TIMEOUT_MS,
              ),
            });
            const sessionInfo = await waitForSpawnedSession({
              ctx,
              marker,
              timeoutMs: parseDiscoveryTimeout(
                opts.timeout,
                DEFAULT_DISCOVERY_TIMEOUT_MS,
              ),
            });
            const latest = readSpawnState(stateFile);
            if (latest) {
              writeSpawnState(stateFile, {
                ...latest,
                browser_id: sessionInfo.browser_id,
                session_url: `${sessionInfo.url ?? ""}`.trim() || undefined,
                updated_at: nowIso(),
              });
            }
            if (opts.use) {
              saveProfileBrowserId({
                deps,
                command,
                browser_id: sessionInfo.browser_id,
              });
            }
            return {
              spawn_id: spawnId,
              pid: daemonPid,
              browser_id: sessionInfo.browser_id,
              state_file: stateFile,
              target_url: targetUrl,
              launched_url: markedTargetUrl,
              session_name: sessionName,
              project_id: project_id ?? "",
              profile: profileSelection.profile,
              profile_default_set: !!opts.use,
              mode: "playwright-spawned",
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          } catch (err) {
            await terminateSpawnedProcess({
              pid: daemonPid,
              timeoutMs: 2_500,
            });
            throw err;
          } finally {
            try {
              unlinkSync(daemonConfigPath);
            } catch {
              // best-effort cleanup
            }
          }
        });
      },
    );

  session
    .command("spawned")
    .description("list locally managed Playwright-spawned browser sessions")
    .action(async (_opts: unknown, command: Command) => {
      await deps.withContext(command, "browser session spawned", async () => {
        return listSpawnStates().map(({ file, state }) => ({
          spawn_id: state.spawn_id,
          pid: state.pid,
          running: isProcessRunning(Number(state.pid)),
          status: state.status,
          browser_id: `${state.browser_id ?? ""}`.trim(),
          session_url: `${state.session_url ?? state.page_url ?? ""}`.trim(),
          target_url: state.target_url,
          updated_at: state.updated_at,
          state_file: file,
        }));
      });
    });

  session
    .command("destroy <id>")
    .description(
      "destroy a Playwright-spawned browser session by spawn id or browser id",
    )
    .option(
      "--timeout <duration>",
      "graceful shutdown timeout before SIGKILL (e.g. 5s, 30s)",
      "10s",
    )
    .option("--keep-state", "do not remove local spawn state file")
    .action(
      async (
        id: string,
        opts: { timeout?: string; keepState?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "browser session destroy", async (ctx) => {
          const resolved = resolveSpawnStateById(id);
          if (!resolved) {
            throw new Error(
              `spawned browser session '${id}' not found (try 'cocalc browser session spawned')`,
            );
          }
          const { file, state } = resolved;
          const pid = Number(state.pid);
          const shutdown = await terminateSpawnedProcess({
            pid,
            timeoutMs: parseDiscoveryTimeout(
              opts.timeout,
              DEFAULT_DESTROY_TIMEOUT_MS,
            ),
          });
          let removedRemoteSession = false;
          const browserId = `${state.browser_id ?? ""}`.trim();
          if (browserId) {
            try {
              const removed = await ctx.hub.system.removeBrowserSession({
                browser_id: browserId,
              });
              removedRemoteSession = !!removed?.removed;
            } catch {
              removedRemoteSession = false;
            }
          }
          const stoppedState: SpawnStateRecord = {
            ...state,
            status: "stopped",
            reason: "destroy-command",
            stopped_at: nowIso(),
            updated_at: nowIso(),
          };
          let stateFileRemoved = false;
          if (opts.keepState) {
            writeSpawnState(file, stoppedState);
          } else {
            try {
              unlinkSync(file);
              stateFileRemoved = true;
            } catch {
              writeSpawnState(file, stoppedState);
            }
          }
          return {
            spawn_id: state.spawn_id,
            pid,
            browser_id: state.browser_id ?? "",
            terminated: shutdown.terminated,
            force_killed: shutdown.killed,
            remote_session_removed: removedRemoteSession,
            state_file: file,
            state_file_removed: stateFileRemoved,
          };
        });
      },
    );
}
