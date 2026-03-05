/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { BrowserScreenshotMetadata } from "@cocalc/conat/service/browser-session";
import { isValidUUID } from "@cocalc/util/misc";
import { durationToMs } from "../../core/utils";
import {
  formatNetworkTraceLine,
  formatRuntimeEventLine,
  parseCoordinateSpace,
  parseCsvStrings,
  parseNetworkDirection,
  parseNetworkPhases,
  parseNetworkProtocols,
  parseOptionalDurationMs,
  parseRequiredNumber,
  parseRuntimeEventLevels,
  parseScreenshotRenderer,
  parseScrollAlign,
  parseScrollBehavior,
} from "./browser/parse-format";
import {
  browserScreenshotDomScript,
  browserScreenshotMediaScript,
  captureScreenshotViaSpawnedDaemon,
  readScreenshotMeta,
} from "./browser/screenshot-helpers";
import {
  readExecScriptFromStdin,
  resolveBrowserPolicyAndPosture,
  waitForExecOperation,
  withBrowserExecStaleSessionHint,
} from "./browser/exec-helpers";
import {
  DEFAULT_DESTROY_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  SPAWN_STATE_DIR,
  buildSpawnCookies,
  isProcessRunning,
  isSeaMode,
  nowIso,
  parseDiscoveryTimeout,
  randomSpawnId,
  readSpawnState,
  resolveChromiumExecutablePath,
  resolveSecret,
  resolveSpawnStateById,
  resolveSpawnTargetUrl,
  spawnStateFile,
  terminateSpawnedProcess,
  waitForSpawnStateReady,
  waitForSpawnedSession,
  withSpawnMarker,
  writeDaemonConfig,
  writeSpawnState,
  listSpawnStates,
} from "./browser/spawn-state";
import {
  browserHintFromOption,
  chooseBrowserSession,
  loadProfileSelection,
  resolveBrowserSession,
  resolveTargetProjectId,
  saveProfileBrowserId,
  sessionMatchesProject,
  sessionTargetContext,
} from "./browser/targeting";
import { registerBrowserActionCommands } from "./browser/register-action-commands";
import { registerBrowserHarnessCommands } from "./browser/register-harness-commands";
import { registerBrowserInspectCommands } from "./browser/register-inspect-commands";
import { registerBrowserObservabilityCommands } from "./browser/register-observability-commands";
import { registerBrowserSessionCommands } from "./browser/register-session-commands";
import type {
  BrowserActionRegisterUtils,
  BrowserCommandDeps,
  BrowserHarnessRegisterUtils,
  BrowserInspectRegisterUtils,
  BrowserObservabilityRegisterUtils,
  BrowserSessionRegisterUtils,
  ScreenshotRenderer,
  SpawnStateRecord,
} from "./browser/types";
export type { BrowserCommandDeps } from "./browser/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerBrowserCommand(
  program: Command,
  deps: BrowserCommandDeps,
): Command {
  const browser = program
    .command("browser")
    .description("browser session discovery and automation");

  const sessionUtils: BrowserSessionRegisterUtils = {
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
  };
  registerBrowserSessionCommands({ browser, deps, utils: sessionUtils });

  browser
    .command("use <browser_id>")
    .description(
      "alias for 'browser session use'; set default browser session id for current profile scoped by API origin",
    )
    .option(
      "--api-url <url>",
      "explicit API URL scope for saved default (defaults to active context API URL)",
    )
    .action(
      async (
        browserHint: string,
        opts: { apiUrl?: string },
        command: Command,
      ) => {
        await deps.withContext(command, "browser use", async (ctx) => {
          const sessions = await ctx.hub.system.listBrowserSessions({
            include_stale: true,
          });
          const selected = resolveBrowserSession(sessions ?? [], browserHint);
          const scopedApiUrl = `${opts.apiUrl ?? ctx.apiBaseUrl ?? ""}`.trim() || undefined;
          const saved = saveProfileBrowserId({
            deps,
            command,
            browser_id: selected.browser_id,
            apiBaseUrl: scopedApiUrl,
          });
          return {
            profile: saved.profile,
            browser_id: selected.browser_id,
            stale: !!selected.stale,
            api_scope: scopedApiUrl ?? null,
            alias_of: "browser session use",
          };
        });
      },
    );

  const observabilityUtils: BrowserObservabilityRegisterUtils = {
    loadProfileSelection,
    chooseBrowserSession,
    browserHintFromOption,
    parseRuntimeEventLevels,
    formatRuntimeEventLine,
    durationToMs,
    sessionTargetContext,
    parseNetworkDirection,
    parseNetworkProtocols,
    parseNetworkPhases,
    formatNetworkTraceLine,
    parseCsvStrings,
    sleep,
  };
  registerBrowserObservabilityCommands({
    browser,
    deps,
    utils: observabilityUtils,
  });

  browser
    .command("target-resolve")
    .description(
      "dry-run browser target resolution (session + workspace/project) without performing an action",
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
      "--require-discovery",
      "force hub discovery even when browser id appears exact",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          requireDiscovery?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser target-resolve", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery:
              !!opts.requireDiscovery ||
              (workspaceHint.length === 0 && projectIdHint.length === 0),
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          let resolvedProjectId: string | undefined;
          let projectError: string | undefined;
          try {
            resolvedProjectId = await resolveTargetProjectId({
              deps,
              ctx,
              workspace: workspaceHint,
              projectId: projectIdHint,
              sessionInfo,
            });
          } catch (err) {
            projectError = `${err}`;
          }
          let workspaceSummary:
            | {
                workspace_id: string;
                title?: string;
                host_id?: string | null;
              }
            | undefined;
          if (resolvedProjectId) {
            try {
              const ws = await deps.resolveWorkspace(ctx, resolvedProjectId);
              workspaceSummary = {
                workspace_id: ws.project_id,
                ...(ws.title ? { title: ws.title } : {}),
                ...(ws.host_id != null ? { host_id: ws.host_id } : {}),
              };
            } catch {
              // best-effort enrichment only
            }
          }
          return {
            browser_id: sessionInfo.browser_id,
            session_name: sessionInfo.session_name ?? "",
            active_project_id: sessionInfo.active_project_id ?? "",
            open_projects: sessionInfo.open_projects?.length ?? 0,
            requested: {
              browser: browserHint || undefined,
              workspace: workspaceHint || undefined,
              project_id: projectIdHint || undefined,
              session_project_id: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              active_only: !!opts.activeOnly,
              require_discovery: !!opts.requireDiscovery,
            },
            resolved: {
              project_id: resolvedProjectId,
              ...(workspaceSummary ? { workspace: workspaceSummary } : {}),
              ...(projectError ? { project_error: projectError } : {}),
            },
            ...sessionTargetContext(ctx, sessionInfo, resolvedProjectId),
          };
        });
      },
    );

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
        });
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
        });
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
          });
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
          });
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
      "--renderer <mode>",
      "screenshot renderer: auto|native|dom|media (default auto)",
      "auto",
    )
    .option(
      "--selector <css>",
      "CSS selector for screenshot root element",
      "body",
    )
    .option(
      "--fullpage",
      "capture full-page screenshot (native renderer; DOM renderer uses html root)",
    )
    .option("--viewport-width <n>", "set viewport width before capture (native)")
    .option("--viewport-height <n>", "set viewport height before capture (native)")
    .option(
      "--scale <n>",
      "render scale for DOM screenshot renderer",
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
    .option(
      "--meta-out <path>",
      "optional output path for screenshot metadata JSON",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          renderer?: string;
          selector?: string;
          fullpage?: boolean;
          viewportWidth?: string;
          viewportHeight?: string;
          scale?: string;
          out?: string;
          metaOut?: string;
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
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });

          const fullPage = !!opts.fullpage;
          const selectorRaw = `${opts.selector ?? ""}`.trim();
          const selector = selectorRaw || (fullPage ? "html" : "body");
          const requestedRenderer = parseScreenshotRenderer(opts.renderer);
          const scale = Number(opts.scale ?? "1");
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error("--scale must be a positive number");
          }
          const viewportWidth = `${opts.viewportWidth ?? ""}`.trim()
            ? Math.floor(Number(opts.viewportWidth))
            : undefined;
          const viewportHeight = `${opts.viewportHeight ?? ""}`.trim()
            ? Math.floor(Number(opts.viewportHeight))
            : undefined;
          if ((viewportWidth == null) !== (viewportHeight == null)) {
            throw new Error("--viewport-width and --viewport-height must be provided together");
          }
          if (
            viewportWidth != null &&
            (!Number.isFinite(viewportWidth) || viewportWidth <= 0)
          ) {
            throw new Error("--viewport-width must be a positive integer");
          }
          if (
            viewportHeight != null &&
            (!Number.isFinite(viewportHeight) || viewportHeight <= 0)
          ) {
            throw new Error("--viewport-height must be a positive integer");
          }
          if (requestedRenderer === "media" && fullPage) {
            throw new Error("--fullpage is not supported with --renderer media");
          }
          if (
            requestedRenderer === "media" &&
            (viewportWidth != null || viewportHeight != null)
          ) {
            throw new Error(
              "--viewport-width/--viewport-height are not supported with --renderer media",
            );
          }
          const waitForIdleMs = `${opts.waitForIdle ?? ""}`.trim()
            ? Math.max(0, durationToMs(opts.waitForIdle, 1_000))
            : 0;
          const outputPath =
            `${opts.out ?? ""}`.trim() ||
            `browser-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const metaOutPath = `${opts.metaOut ?? ""}`.trim();
          let rendererUsed: ScreenshotRenderer = requestedRenderer;
          let result: Record<string, unknown> | undefined;
          let spawnedUsed:
            | {
                file: string;
                state: SpawnStateRecord;
              }
            | undefined;

          if (requestedRenderer === "native" || requestedRenderer === "auto") {
            try {
              const nativeResult = await captureScreenshotViaSpawnedDaemon({
                browser_id: sessionInfo.browser_id,
                selector,
                waitForIdleMs,
                timeoutMs,
                fullPage,
                viewportWidth,
                viewportHeight,
              });
              result = nativeResult.result;
              spawnedUsed = nativeResult.spawned;
              rendererUsed = "native";
            } catch (err) {
              if (requestedRenderer === "native") {
                throw err;
              }
              if (viewportWidth != null || viewportHeight != null) {
                throw new Error(
                  `${err}\n\nviewport controls require native screenshot capture from a spawned browser session; retry with --renderer native after 'cocalc browser session spawn --use'.`,
                );
              }
            }
          }

          if (!result) {
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: timeoutMs,
            });
            const modeForExec: ScreenshotRenderer =
              requestedRenderer === "media"
                ? "media"
                : requestedRenderer === "dom"
                  ? "dom"
                  : "dom";
            const script =
              modeForExec === "media"
                ? browserScreenshotMediaScript({
                    selector,
                    waitForIdleMs,
                  })
                : browserScreenshotDomScript({
                    selector,
                    scale,
                    waitForIdleMs,
                  });
            const started = await browserClient.startExec({
              project_id,
              code: script,
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
            const opResult = op?.result;
            result =
              opResult && typeof opResult === "object"
                ? (opResult as Record<string, unknown>)
                : {};
            rendererUsed = modeForExec;
          }

          const pngDataUrl = `${result?.png_data_url ?? ""}`.trim();
          if (!pngDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("browser screenshot capture returned invalid PNG data");
          }
          const base64 = pngDataUrl.slice("data:image/png;base64,".length);
          const png = Buffer.from(base64, "base64");
          await writeFile(outputPath, png);
          const screenshotMeta = (result?.screenshot_meta ?? {
            page_url: `${result?.page_url ?? ""}`,
            captured_at: `${result?.captured_at ?? ""}`,
            selector,
            image_width: Number(result?.width ?? 0),
            image_height: Number(result?.height ?? 0),
            capture_scale: Number(result?.capture_scale ?? scale),
            device_pixel_ratio: Number(result?.device_pixel_ratio ?? 1),
            scroll_x: Number(result?.scroll_x ?? 0),
            scroll_y: Number(result?.scroll_y ?? 0),
            selector_rect_css: result?.selector_rect_css,
            viewport_css: result?.viewport_css,
          }) as BrowserScreenshotMetadata;
          if (metaOutPath) {
            await writeFile(
              metaOutPath,
              `${JSON.stringify(screenshotMeta, null, 2)}\n`,
              "utf8",
            );
          }

          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            output_path: resolvePath(outputPath),
            ...(metaOutPath ? { meta_output_path: resolvePath(metaOutPath) } : {}),
            bytes: png.byteLength,
            width: Number(result?.width ?? 0),
            height: Number(result?.height ?? 0),
            renderer_requested: requestedRenderer,
            renderer_used: rendererUsed,
            ...(spawnedUsed
              ? {
                  spawn_id: spawnedUsed.state.spawn_id,
                  spawn_state_file: spawnedUsed.file,
                }
              : {}),
            selector,
            full_page: !!result?.full_page || fullPage,
            ...(viewportWidth != null ? { viewport_width: viewportWidth } : {}),
            ...(viewportHeight != null ? { viewport_height: viewportHeight } : {}),
            wait_for_idle_ms: Number(result?.wait_for_idle_ms ?? waitForIdleMs),
            wait_for_idle_timed_out: !!result?.wait_for_idle_timed_out,
            page_url: `${result?.page_url ?? ""}`,
            screenshot_meta: screenshotMeta,
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option(
      "--policy-file <path>",
      "JSON file with browser exec policy (prod defaults to sandboxed exec unless allow_raw_exec=true)",
    )
    .option(
      "--allow-raw-exec",
      "explicitly allow raw JS exec (sets policy.allow_raw_exec=true)",
    )
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
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
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
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          });
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            allowRawExec: opts.allowRawExec,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          if (opts.async) {
            let started;
            try {
              started = await browserClient.startExec({
                project_id,
                code: script,
                posture,
                policy,
              });
            } catch (err) {
              throw withBrowserExecStaleSessionHint({
                err,
                posture,
                policy,
                browserId: sessionInfo.browser_id,
              });
            }
            if (!opts.wait) {
              return {
                browser_id: sessionInfo.browser_id,
                project_id,
                posture,
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
              posture,
              ...op,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          }
          let response;
          try {
            response = await browserClient.exec({
              project_id,
              code: script,
              posture,
              policy,
            });
          } catch (err) {
            throw withBrowserExecStaleSessionHint({
              err,
              posture,
              policy,
              browserId: sessionInfo.browser_id,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  const actionUtils: BrowserActionRegisterUtils = {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    parseOptionalDurationMs,
    parseCoordinateSpace,
    readScreenshotMeta,
    parseRequiredNumber,
    sessionTargetContext,
    parseScrollBehavior,
    parseScrollAlign,
    durationToMs,
  };
  registerBrowserActionCommands({ browser, deps, utils: actionUtils });

  const harnessUtils: BrowserHarnessRegisterUtils = {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    sessionTargetContext,
    durationToMs,
  };
  registerBrowserHarnessCommands({ browser, deps, utils: harnessUtils });

  const inspectUtils: BrowserInspectRegisterUtils = {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    sessionTargetContext,
    durationToMs,
  };
  registerBrowserInspectCommands({ browser, deps, utils: inspectUtils });

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
          });
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
          });
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
          });
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
