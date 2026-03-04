/*
Register `cocalc browser action ...` subcommands.

This extracts the typed browser action command surface from the monolithic
browser command file so action-related UX and policy behavior can evolve
independently from session/discovery/logging commands.
*/

import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type {
  BrowserAtomicActionRequest,
  BrowserActionRegisterUtils,
  BrowserCommandDeps,
} from "./types";

type RegisterActionDeps = {
  browser: Command;
  deps: BrowserCommandDeps;
  utils: BrowserActionRegisterUtils;
};

export function registerBrowserActionCommands({
  browser,
  deps,
  utils,
}: RegisterActionDeps): void {
  const {
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
  } = utils;
  const action = browser
    .command("action")
    .description("run typed browser automation actions without raw JS");

  action
    .command("click <selector>")
    .description("click an element by CSS selector")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--button <left|middle|right>", "mouse button", "left")
    .option("--click-count <n>", "number of clicks", "1")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-navigation <duration>",
      "after click, wait for URL change up to this duration",
    )
    .action(
      async (
        selector: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          button?: string;
          clickCount?: string;
          timeout?: string;
          waitForNavigation?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action click", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const waitForNavigationMs = parseOptionalDurationMs(
            opts.waitForNavigation,
            5_000,
          );
          const cleanSelector = `${selector ?? ""}`.trim();
          if (!cleanSelector) {
            throw new Error("selector must be specified");
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const clickCount = Number(opts.clickCount ?? "1");
          if (!Number.isFinite(clickCount) || clickCount <= 0) {
            throw new Error("--click-count must be a positive number");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "click",
              selector: cleanSelector,
              button,
              click_count: Math.floor(clickCount),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(waitForNavigationMs != null
                ? { wait_for_navigation_ms: waitForNavigationMs }
                : {}),
            },
          });
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

  action
    .command("click-at <x> <y>")
    .description(
      "click at coordinates (useful for canvas/plotly); supports screenshot metadata mapping",
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--space <viewport|selector|image|normalized>",
      "coordinate space for x/y",
      "viewport",
    )
    .option("--selector <css>", "selector anchor for selector/image space")
    .option(
      "--meta-file <path>",
      "screenshot metadata JSON from 'browser screenshot --meta-out'",
    )
    .option(
      "--strict-meta",
      "require current page url (and selector, if provided) to match metadata",
    )
    .option("--button <left|middle|right>", "mouse button", "left")
    .option("--click-count <n>", "number of clicks", "1")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-navigation <duration>",
      "after click, wait for URL change up to this duration",
    )
    .action(
      async (
        x: string,
        y: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          space?: string;
          selector?: string;
          metaFile?: string;
          strictMeta?: boolean;
          button?: string;
          clickCount?: string;
          timeout?: string;
          waitForNavigation?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action click-at", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const waitForNavigationMs = parseOptionalDurationMs(
            opts.waitForNavigation,
            5_000,
          );
          const space = parseCoordinateSpace(opts.space);
          const screenshotMeta = await readScreenshotMeta(opts.metaFile);
          const selector =
            `${opts.selector ?? ""}`.trim() ||
            `${screenshotMeta?.selector ?? ""}`.trim();
          if (
            (space === "selector" || space === "image") &&
            !selector
          ) {
            throw new Error(
              "--selector (or screenshot metadata with selector) is required for selector/image coordinate space",
            );
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const clickCount = Number(opts.clickCount ?? "1");
          if (!Number.isFinite(clickCount) || clickCount <= 0) {
            throw new Error("--click-count must be a positive number");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "click_at",
              x: parseRequiredNumber(x, "x"),
              y: parseRequiredNumber(y, "y"),
              space,
              ...(selector ? { selector } : {}),
              button,
              click_count: Math.floor(clickCount),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(waitForNavigationMs != null
                ? { wait_for_navigation_ms: waitForNavigationMs }
                : {}),
              ...(screenshotMeta ? { screenshot_meta: screenshotMeta } : {}),
              strict_meta: !!opts.strictMeta,
            },
          });
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

  action
    .command("drag <x1> <y1> <x2> <y2>")
    .description(
      "drag from one coordinate to another (useful for plotly/canvas interactions)",
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--space <viewport|selector|image|normalized>",
      "coordinate space for x/y pairs",
      "viewport",
    )
    .option("--selector <css>", "selector anchor for selector/image space")
    .option(
      "--meta-file <path>",
      "screenshot metadata JSON from 'browser screenshot --meta-out'",
    )
    .option(
      "--strict-meta",
      "require current page url (and selector, if provided) to match metadata",
    )
    .option("--button <left|middle|right>", "mouse button for drag", "left")
    .option("--steps <n>", "number of intermediate move steps", "14")
    .option(
      "--hold <duration>",
      "optional hold duration after mousedown before moving",
    )
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        x1: string,
        y1: string,
        x2: string,
        y2: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          space?: string;
          selector?: string;
          metaFile?: string;
          strictMeta?: boolean;
          button?: string;
          steps?: string;
          hold?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action drag", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const holdMs = parseOptionalDurationMs(opts.hold, 100);
          const space = parseCoordinateSpace(opts.space);
          const screenshotMeta = await readScreenshotMeta(opts.metaFile);
          const selector =
            `${opts.selector ?? ""}`.trim() ||
            `${screenshotMeta?.selector ?? ""}`.trim();
          if (
            (space === "selector" || space === "image") &&
            !selector
          ) {
            throw new Error(
              "--selector (or screenshot metadata with selector) is required for selector/image coordinate space",
            );
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const steps = Math.floor(parseRequiredNumber(opts.steps ?? "14", "steps"));
          if (!Number.isFinite(steps) || steps < 1) {
            throw new Error("--steps must be a positive integer");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "drag",
              x1: parseRequiredNumber(x1, "x1"),
              y1: parseRequiredNumber(y1, "y1"),
              x2: parseRequiredNumber(x2, "x2"),
              y2: parseRequiredNumber(y2, "y2"),
              space,
              ...(selector ? { selector } : {}),
              button,
              steps,
              ...(holdMs != null ? { hold_ms: holdMs } : {}),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(screenshotMeta ? { screenshot_meta: screenshotMeta } : {}),
              strict_meta: !!opts.strictMeta,
            },
          });
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

  action
    .command("type <selector> <text...>")
    .description("type text into an input/textarea/contenteditable target")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--append", "append text instead of replacing existing value")
    .option("--clear", "clear existing content before typing")
    .option("--submit", "submit closest form after typing")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        selector: string,
        text: string[],
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          append?: boolean;
          clear?: boolean;
          submit?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action type", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const cleanSelector = `${selector ?? ""}`.trim();
          const cleanText = (text ?? []).join(" ");
          if (!cleanSelector) {
            throw new Error("selector must be specified");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "type",
              selector: cleanSelector,
              text: cleanText,
              append: !!opts.append,
              clear: !!opts.clear,
              submit: !!opts.submit,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
            },
          });
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

  action
    .command("press <key>")
    .description("dispatch a key press on target selector (or active element)")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--selector <css>", "optional CSS selector to focus before key press")
    .option("--ctrl", "press Control/Ctrl modifier")
    .option("--alt", "press Alt modifier")
    .option("--shift", "press Shift modifier")
    .option("--meta", "press Meta/Command modifier")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        key: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          selector?: string;
          ctrl?: boolean;
          alt?: boolean;
          shift?: boolean;
          meta?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action press", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const cleanKey = `${key ?? ""}`.trim();
          if (!cleanKey) {
            throw new Error("key must be specified");
          }
          const cleanSelector = `${opts.selector ?? ""}`.trim();
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "press",
              key: cleanKey,
              ...(cleanSelector ? { selector: cleanSelector } : {}),
              ctrl: !!opts.ctrl,
              alt: !!opts.alt,
              shift: !!opts.shift,
              meta: !!opts.meta,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
            },
          });
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

  action
    .command("wait-for-selector <selector>")
    .description("wait for selector state transition")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--state <attached|visible|hidden|detached>",
      "desired selector state",
      "visible",
    )
    .option(
      "--timeout <duration>",
      "timeout for wait operation (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 100ms, 1s)",
      "100ms",
    )
    .action(
      async (
        selector: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          state?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser action wait-for-selector",
          async (ctx) => {
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
            const { posture, policy } = await resolveBrowserPolicyAndPosture({
              posture: opts.posture,
              policyFile: opts.policyFile,
              apiBaseUrl: ctx.apiBaseUrl,
            });
            const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
            const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
            const cleanSelector = `${selector ?? ""}`.trim();
            const state = `${opts.state ?? "visible"}`.trim().toLowerCase() as
              | "attached"
              | "visible"
              | "hidden"
              | "detached";
            if (!cleanSelector) {
              throw new Error("selector must be specified");
            }
            if (!["attached", "visible", "hidden", "detached"].includes(state)) {
              throw new Error("--state must be one of attached|visible|hidden|detached");
            }
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
            });
            const response = await browserClient.action({
              project_id,
              posture,
              policy,
              action: {
                name: "wait_for_selector",
                selector: cleanSelector,
                state,
                ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
                poll_ms: pollMs,
              },
            });
            return {
              browser_id: sessionInfo.browser_id,
              project_id,
              posture,
              ok: !!response?.ok,
              result: response?.result ?? null,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          },
        );
      },
    );

  action
    .command("wait-for-url [pattern]")
    .description("wait for URL match by exact URL, substring, or regex")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--url <value>", "exact URL match")
    .option("--includes <value>", "URL substring match")
    .option("--regex <value>", "JavaScript regex pattern")
    .option(
      "--timeout <duration>",
      "timeout for wait operation (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 100ms, 1s)",
      "100ms",
    )
    .action(
      async (
        pattern: string | undefined,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          url?: string;
          includes?: string;
          regex?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action wait-for-url", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
          const cleanPattern = `${pattern ?? ""}`.trim();
          const url = `${opts.url ?? ""}`.trim();
          const includes = `${opts.includes ?? cleanPattern}`.trim();
          const regex = `${opts.regex ?? ""}`.trim();
          if (!url && !includes && !regex) {
            throw new Error(
              "URL matcher required: pass [pattern], --url, --includes, or --regex",
            );
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "wait_for_url",
              ...(url ? { url } : {}),
              ...(includes ? { includes } : {}),
              ...(regex ? { regex } : {}),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              poll_ms: pollMs,
            },
          });
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

  action
    .command("reload")
    .description("reload the targeted browser session page")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--hard",
      "best-effort hard refresh; appends a cache-busting query parameter and replaces current URL",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          hard?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action reload", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: ctx.timeoutMs,
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "reload",
              hard: !!opts.hard,
            },
          });
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

  action
    .command("navigate <url>")
    .description("navigate browser session to a URL")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--replace", "replace current history entry instead of pushing")
    .option(
      "--wait-for-url <duration>",
      "after navigate, wait up to this duration for URL change",
    )
    .action(
      async (
        url: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          replace?: boolean;
          waitForUrl?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action navigate", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const cleanUrl = `${url ?? ""}`.trim();
          if (!cleanUrl) {
            throw new Error("url must be specified");
          }
          const waitForUrlMs = parseOptionalDurationMs(opts.waitForUrl, 5_000);
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.waitForUrl, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "navigate",
              url: cleanUrl,
              replace: !!opts.replace,
              ...(waitForUrlMs != null ? { wait_for_url_ms: waitForUrlMs } : {}),
            },
          });
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

  action
    .command("scroll-by <dy> [dx]")
    .description("scroll viewport by delta values")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--behavior <auto|smooth>", "scroll behavior", "auto")
    .action(
      async (
        dy: string,
        dx: string | undefined,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          behavior?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action scroll-by", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const dyValue = parseRequiredNumber(dy, "dy");
          const dxValue = dx == null ? 0 : parseRequiredNumber(dx, "dx");
          const behavior = parseScrollBehavior(opts.behavior);
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "scroll_by",
              dx: dxValue,
              dy: dyValue,
              behavior,
            },
          });
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

  action
    .command("scroll-to")
    .description(
      "scroll to selector (recommended) or explicit top/left coordinates",
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--selector <css>", "CSS selector target to bring into view")
    .option("--top <n>", "absolute vertical scroll position")
    .option("--left <n>", "absolute horizontal scroll position")
    .option("--behavior <auto|smooth>", "scroll behavior", "auto")
    .option(
      "--block <start|center|end|nearest>",
      "vertical alignment when selector is provided",
      "center",
    )
    .option(
      "--inline <start|center|end|nearest>",
      "horizontal alignment when selector is provided",
      "nearest",
    )
    .option(
      "--timeout <duration>",
      "timeout when waiting for selector (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting for selector",
      "100ms",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          selector?: string;
          top?: string;
          left?: string;
          behavior?: string;
          block?: string;
          inline?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action scroll-to", async (ctx) => {
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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const selector = `${opts.selector ?? ""}`.trim();
          const top =
            opts.top == null || `${opts.top}`.trim() === ""
              ? undefined
              : parseRequiredNumber(opts.top, "top");
          const left =
            opts.left == null || `${opts.left}`.trim() === ""
              ? undefined
              : parseRequiredNumber(opts.left, "left");
          if (!selector && top == null && left == null) {
            throw new Error("pass --selector or at least one of --top/--left");
          }
          const behavior = parseScrollBehavior(opts.behavior);
          const block = parseScrollAlign(opts.block, "block");
          const inline = parseScrollAlign(opts.inline, "inline");
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "scroll_to",
              ...(selector ? { selector } : {}),
              ...(top != null ? { top } : {}),
              ...(left != null ? { left } : {}),
              behavior,
              block,
              inline,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              poll_ms: pollMs,
            },
          });
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

  action
    .command("batch")
    .description(
      "execute multiple typed actions in one call using a JSON file (array or {actions, continue_on_error})",
    )
    .requiredOption("--file <path>", "JSON file describing action batch")
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
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--continue-on-error",
      "continue remaining steps after a step fails",
    )
    .option(
      "--timeout <duration>",
      "rpc timeout for batch execution",
    )
    .action(
      async (
        opts: {
          file?: string;
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          continueOnError?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action batch", async (ctx) => {
          const file = `${opts.file ?? ""}`.trim();
          if (!file) {
            throw new Error("--file is required");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(file, "utf8"));
          } catch (err) {
            throw new Error(`invalid batch json file '${file}': ${err}`);
          }
          const parsedObject =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : undefined;
          const actions: BrowserAtomicActionRequest[] | undefined = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsedObject?.actions)
              ? parsedObject?.actions
              : undefined;
          if (!Array.isArray(actions) || actions.length === 0) {
            throw new Error("batch file must contain an action array or { actions: [...] }");
          }
          const continueOnErrorFromFile =
            parsedObject?.continue_on_error == null
              ? undefined
              : !!parsedObject.continue_on_error;
          const continueOnError =
            opts.continueOnError || continueOnErrorFromFile === true;

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
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          });
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "batch",
              actions,
              continue_on_error: continueOnError,
            },
          });
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

}
