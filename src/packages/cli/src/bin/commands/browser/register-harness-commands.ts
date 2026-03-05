/*
Register `cocalc browser harness ...` subcommands.

Harness mode executes a JSON step plan with retries, recovery, and artifact
reporting so long-running browser QA workflows are reproducible.
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import { Command } from "commander";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import type {
  BrowserActionRequest,
  BrowserAutomationPosture,
  BrowserExecPolicyV1,
} from "@cocalc/conat/service/browser-session";
import { browserScreenshotDomScript } from "./screenshot-helpers";
import { readExecScriptFromStdin, withBrowserExecStaleSessionHint } from "./exec-helpers";
import { sessionMatchesSpawnMarker, spawnMarkerFromUrl } from "./spawn-state";
import type {
  BrowserCommandDeps,
  BrowserHarnessRegisterUtils,
  BrowserSessionClient,
} from "./types";

type RegisterHarnessDeps = {
  browser: Command;
  deps: BrowserCommandDeps;
  utils: BrowserHarnessRegisterUtils;
};

type HarnessRecoveryMode = "none" | "reload" | "hard_reload";

type HarnessCapturePolicy = {
  screenshot_on_fail: boolean;
  logs_on_fail: number;
  network_on_fail: number;
  network_include_decoded: boolean;
};

type HarnessPlan = {
  name?: string;
  continue_on_error?: boolean;
  default_retries?: number;
  default_timeout_ms?: number;
  default_recovery?: HarnessRecoveryMode;
  default_pause_ms?: number;
  max_failures?: number;
  capture?: Partial<HarnessCapturePolicy>;
  before_all?: unknown[];
  steps: unknown[];
  after_all?: unknown[];
};

type HarnessPlanStepBase = {
  id?: string;
  name?: string;
  retries?: number;
  timeout_ms?: number;
  recovery?: HarnessRecoveryMode;
  pause_ms?: number;
  continue_on_error?: boolean;
  capture?: Partial<HarnessCapturePolicy>;
};

type HarnessExecStep = HarnessPlanStepBase & {
  exec: string | { code?: string; file?: string };
};

type NormalizedStepBase = {
  id?: string;
  name: string;
  phase: "before_all" | "main" | "after_all";
  retries: number;
  timeout_ms?: number;
  recovery: HarnessRecoveryMode;
  pause_ms: number;
  continue_on_error: boolean;
  capture: HarnessCapturePolicy;
};

type NormalizedActionStep = NormalizedStepBase & {
  kind: "action";
  action: BrowserActionRequest;
};

type NormalizedExecStep = NormalizedStepBase & {
  kind: "exec";
  code: string;
};

type NormalizedAssertStep = NormalizedStepBase & {
  kind: "assert";
  code: string;
  expect_set: boolean;
  expect_value?: unknown;
  truthy: boolean;
};

type NormalizedSleepStep = NormalizedStepBase & {
  kind: "sleep";
  sleep_ms: number;
};

type NormalizedStep =
  | NormalizedActionStep
  | NormalizedExecStep
  | NormalizedAssertStep
  | NormalizedSleepStep;

type StepAttemptReport = {
  attempt: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
  result?: unknown;
  recovery?: {
    mode: HarnessRecoveryMode;
    ok: boolean;
    error?: string;
  };
  timeout_burst_recovery?: {
    threshold: number;
    observed_consecutive: number;
    ok: boolean;
    browser_id?: string;
    error?: string;
  };
  artifacts?: {
    screenshot_path?: string;
    logs_path?: string;
    network_path?: string;
    capture_errors?: string[];
  };
};

type StepReport = {
  index: number;
  id?: string;
  name: string;
  phase: "before_all" | "main" | "after_all";
  kind: NormalizedStep["kind"];
  ok: boolean;
  attempts: number;
  final_error?: string;
  failure_signature?: string;
  attempt_reports: StepAttemptReport[];
};

type FailureSignatureRow = {
  signature: string;
  count: number;
  phases: string[];
  step_names: string[];
  errors: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampNonNegativeInt(value: unknown, fallback: number, label: string): number {
  if (value == null || `${value}`.trim() === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.floor(num);
}

function parseRecoveryMode(value: unknown, fallback: HarnessRecoveryMode): HarnessRecoveryMode {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return fallback;
  if (clean === "none") return "none";
  if (clean === "reload") return "reload";
  if (clean === "hard_reload" || clean === "hard-reload" || clean === "hardreload") {
    return "hard_reload";
  }
  throw new Error(`invalid recovery mode '${value}'; expected none|reload|hard-reload`);
}

function parseCapturePolicy(
  value: unknown,
  defaults: HarnessCapturePolicy,
): HarnessCapturePolicy {
  if (!isObject(value)) return defaults;
  return {
    screenshot_on_fail:
      value.screenshot_on_fail == null
        ? defaults.screenshot_on_fail
        : !!value.screenshot_on_fail,
    logs_on_fail: clampNonNegativeInt(
      value.logs_on_fail,
      defaults.logs_on_fail,
      "capture.logs_on_fail",
    ),
    network_on_fail: clampNonNegativeInt(
      value.network_on_fail,
      defaults.network_on_fail,
      "capture.network_on_fail",
    ),
    network_include_decoded:
      value.network_include_decoded == null
        ? defaults.network_include_decoded
        : !!value.network_include_decoded,
  };
}

async function loadHarnessPlan(planFile: string): Promise<HarnessPlan> {
  const clean = `${planFile ?? ""}`.trim();
  if (!clean) {
    throw new Error("--plan <path> is required");
  }
  const raw = clean === "-" ? await readExecScriptFromStdin() : await readFile(clean, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in harness plan '${clean}': ${err}`);
  }
  if (!isObject(parsed)) {
    throw new Error("harness plan must be a JSON object");
  }
  const steps = parsed.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("harness plan must include non-empty steps[] array");
  }
  return parsed as unknown as HarnessPlan;
}

async function resolveExecCode(step: HarnessExecStep): Promise<string> {
  const exec = step.exec;
  if (typeof exec === "string") {
    if (!exec.trim()) throw new Error("exec step script must not be empty");
    return exec;
  }
  if (!isObject(exec)) {
    throw new Error("exec step must be a string or object with code/file");
  }
  const inline = `${exec.code ?? ""}`;
  const file = `${exec.file ?? ""}`.trim();
  const hasInline = inline.trim().length > 0;
  const hasFile = file.length > 0;
  if ((hasInline ? 1 : 0) + (hasFile ? 1 : 0) !== 1) {
    throw new Error("exec step requires exactly one of exec.code or exec.file");
  }
  if (hasInline) return inline;
  if (file === "-") {
    return await readExecScriptFromStdin();
  }
  return await readFile(file, "utf8");
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeFailureSignature({
  step,
  error,
}: {
  step: NormalizedStep;
  error: string;
}): string {
  const firstLine = `${error ?? ""}`.split("\n")[0]?.trim() || "unknown-error";
  const collapsed = firstLine
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .slice(0, 220);
  return `${step.kind}:${collapsed}`;
}

function isRpcTimeoutError(err: unknown): boolean {
  const msg = `${err instanceof Error ? err.message : err}`.toLowerCase();
  return (
    msg.includes("operation has timed out") ||
    msg.includes("timed out subject:services.account.") ||
    (msg.includes("timeout") && msg.includes("browser-session"))
  );
}

async function normalizePlan({
  plan,
  defaultRetries,
  defaultTimeoutMs,
  defaultRecovery,
  defaultPauseMs,
  maxFailuresOverride,
  continueOnError,
  captureDefaults,
}: {
  plan: HarnessPlan;
  defaultRetries: number;
  defaultTimeoutMs?: number;
  defaultRecovery: HarnessRecoveryMode;
  defaultPauseMs: number;
  maxFailuresOverride?: number;
  continueOnError: boolean;
  captureDefaults: HarnessCapturePolicy;
}): Promise<{
  name: string;
  continue_on_error: boolean;
  max_failures?: number;
  before_steps: NormalizedStep[];
  steps: NormalizedStep[];
  after_steps: NormalizedStep[];
}> {
  const resolvedContinue =
    plan.continue_on_error == null ? continueOnError : !!plan.continue_on_error;
  const resolvedDefaultRetries = clampNonNegativeInt(
    plan.default_retries,
    defaultRetries,
    "default_retries",
  );
  const resolvedDefaultTimeout =
    plan.default_timeout_ms == null
      ? defaultTimeoutMs
      : clampNonNegativeInt(plan.default_timeout_ms, defaultTimeoutMs ?? 0, "default_timeout_ms");
  const resolvedDefaultPause = clampNonNegativeInt(
    plan.default_pause_ms,
    defaultPauseMs,
    "default_pause_ms",
  );
  const resolvedDefaultRecovery = parseRecoveryMode(
    plan.default_recovery,
    defaultRecovery,
  );
  const resolvedCaptureDefaults = parseCapturePolicy(plan.capture, captureDefaults);
  const planMaxFailures =
    plan.max_failures == null
      ? undefined
      : clampNonNegativeInt(plan.max_failures, 0, "max_failures");
  const resolvedMaxFailures = maxFailuresOverride ?? planMaxFailures;

  const normalizeStepList = async ({
    list,
    phase,
  }: {
    list: unknown[];
    phase: "before_all" | "main" | "after_all";
  }): Promise<NormalizedStep[]> => {
    const out: NormalizedStep[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const raw = list[i];
      const label = `${phase} step ${i + 1}`;
      if (!isObject(raw)) {
        throw new Error(`${label} must be an object`);
      }
      const base: NormalizedStepBase = {
        ...(raw.id ? { id: `${raw.id}` } : {}),
        name: `${raw.name ?? raw.id ?? `${phase}-step-${i + 1}`}`,
        phase,
        retries: clampNonNegativeInt(
          raw.retries,
          resolvedDefaultRetries,
          `${label}.retries`,
        ),
        timeout_ms:
          raw.timeout_ms == null
            ? resolvedDefaultTimeout
            : clampNonNegativeInt(
                raw.timeout_ms,
                resolvedDefaultTimeout ?? 0,
                `${label}.timeout_ms`,
              ),
        recovery: parseRecoveryMode(raw.recovery, resolvedDefaultRecovery),
        pause_ms: clampNonNegativeInt(
          raw.pause_ms,
          resolvedDefaultPause,
          `${label}.pause_ms`,
        ),
        continue_on_error:
          raw.continue_on_error == null
            ? resolvedContinue
            : !!raw.continue_on_error,
        capture: parseCapturePolicy(raw.capture, resolvedCaptureDefaults),
      };

      if (raw.sleep_ms != null) {
        out.push({
          ...base,
          kind: "sleep",
          sleep_ms: clampNonNegativeInt(raw.sleep_ms, 0, `${label}.sleep_ms`),
        });
        continue;
      }

      if (raw.action != null) {
        if (!isObject(raw.action)) {
          throw new Error(`${label}.action must be an object`);
        }
        const actionName = `${(raw.action as Record<string, unknown>).name ?? ""}`.trim();
        if (!actionName) {
          throw new Error(`${label}.action.name is required`);
        }
        out.push({
          ...base,
          kind: "action",
          action: raw.action as BrowserActionRequest,
        });
        continue;
      }

      if (raw.exec != null) {
        const execStep = { exec: raw.exec } as HarnessExecStep;
        const code = await resolveExecCode(execStep);
        out.push({
          ...base,
          kind: "exec",
          code,
        });
        continue;
      }

      if (raw.assert != null) {
        let code = "";
        let expectSet = false;
        let expectValue: unknown;
        let truthy = true;
        if (typeof raw.assert === "string") {
          code = raw.assert;
        } else if (isObject(raw.assert)) {
          const assertObj = raw.assert as Record<string, unknown>;
          const assertCode = `${assertObj.code ?? ""}`;
          const assertFile = `${assertObj.file ?? ""}`.trim();
          const hasCode = assertCode.trim().length > 0;
          const hasFile = assertFile.length > 0;
          if ((hasCode ? 1 : 0) + (hasFile ? 1 : 0) !== 1) {
            throw new Error(
              `${label}.assert requires exactly one of assert.code or assert.file`,
            );
          }
          code = hasCode
            ? assertCode
            : await resolveExecCode({
                exec: { file: assertFile },
              });
          if (hasOwn(assertObj, "expect")) {
            expectSet = true;
            expectValue = assertObj.expect;
          } else if (hasOwn(assertObj, "truthy")) {
            truthy = !!assertObj.truthy;
          }
        } else {
          throw new Error(`${label}.assert must be string or object`);
        }
        if (!code.trim()) {
          throw new Error(`${label}.assert code must not be empty`);
        }
        out.push({
          ...base,
          kind: "assert",
          code,
          expect_set: expectSet,
          ...(expectSet ? { expect_value: expectValue } : {}),
          truthy,
        });
        continue;
      }

      throw new Error(
        `${label} must include one of: sleep_ms, action, exec, assert`,
      );
    }
    return out;
  };

  const beforeRaw = Array.isArray(plan.before_all) ? plan.before_all : [];
  const mainRaw = Array.isArray(plan.steps) ? plan.steps : [];
  const afterRaw = Array.isArray(plan.after_all) ? plan.after_all : [];
  const beforeSteps = await normalizeStepList({ list: beforeRaw, phase: "before_all" });
  const steps = await normalizeStepList({ list: mainRaw, phase: "main" });
  const afterSteps = await normalizeStepList({ list: afterRaw, phase: "after_all" });

  return {
    name: `${plan.name ?? "browser-harness"}`,
    continue_on_error: resolvedContinue,
    ...(resolvedMaxFailures != null ? { max_failures: resolvedMaxFailures } : {}),
    before_steps: beforeSteps,
    steps,
    after_steps: afterSteps,
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function captureFailureArtifacts({
  browserClient,
  step,
  reportDir,
  stepIndex,
  attempt,
  project_id,
  posture,
  policy,
}: {
  browserClient: BrowserSessionClient;
  step: NormalizedStep;
  reportDir: string;
  stepIndex: number;
  attempt: number;
  project_id: string;
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): Promise<StepAttemptReport["artifacts"]> {
  const captureErrors: string[] = [];
  const baseName = `step-${String(stepIndex + 1).padStart(3, "0")}-attempt-${attempt}`;
  const artifactsDir = resolvePath(reportDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  let screenshotPath: string | undefined;
  if (step.capture.screenshot_on_fail) {
    const screenshotScript = browserScreenshotDomScript({
      selector: "body",
      scale: 1,
      waitForIdleMs: 250,
    });
    try {
      const screenshotResponse = await browserClient.exec({
        project_id,
        code: screenshotScript,
        posture,
        policy,
      });
      const result = screenshotResponse?.result;
      const row = isObject(result) ? result : {};
      const pngDataUrl = `${row.png_data_url ?? ""}`.trim();
      if (!pngDataUrl.startsWith("data:image/png;base64,")) {
        throw new Error("screenshot exec returned invalid png_data_url");
      }
      const png = Buffer.from(
        pngDataUrl.slice("data:image/png;base64,".length),
        "base64",
      );
      screenshotPath = resolvePath(artifactsDir, `${baseName}.png`);
      await writeFile(screenshotPath, png);
      const metaPath = resolvePath(artifactsDir, `${baseName}.meta.json`);
      await writeJsonFile(metaPath, row.screenshot_meta ?? row);
    } catch (err) {
      captureErrors.push(`screenshot capture failed: ${err}`);
    }
  }

  let logsPath: string | undefined;
  if (step.capture.logs_on_fail > 0) {
    try {
      const logs = await browserClient.listRuntimeEvents({
        limit: step.capture.logs_on_fail,
      });
      logsPath = resolvePath(artifactsDir, `${baseName}.runtime-events.json`);
      await writeJsonFile(logsPath, logs);
    } catch (err) {
      captureErrors.push(`runtime event capture failed: ${err}`);
    }
  }

  let networkPath: string | undefined;
  if (step.capture.network_on_fail > 0) {
    try {
      const network = await browserClient.listNetworkTrace({
        limit: step.capture.network_on_fail,
        include_decoded: step.capture.network_include_decoded,
      });
      networkPath = resolvePath(artifactsDir, `${baseName}.network-trace.json`);
      await writeJsonFile(networkPath, network);
    } catch (err) {
      captureErrors.push(`network trace capture failed: ${err}`);
    }
  }

  return {
    ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
    ...(logsPath ? { logs_path: logsPath } : {}),
    ...(networkPath ? { network_path: networkPath } : {}),
    ...(captureErrors.length > 0 ? { capture_errors: captureErrors } : {}),
  };
}

async function applyRecovery({
  browserClient,
  mode,
  project_id,
  posture,
  policy,
  recoveryWaitMs,
}: {
  browserClient: BrowserSessionClient;
  mode: HarnessRecoveryMode;
  project_id: string;
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
  recoveryWaitMs: number;
}): Promise<{ mode: HarnessRecoveryMode; ok: boolean; error?: string }> {
  if (mode === "none") {
    return { mode, ok: true };
  }
  try {
    await browserClient.action({
      project_id,
      posture,
      policy,
      action: {
        name: "reload",
        ...(mode === "hard_reload" ? { hard: true } : {}),
      },
    });
    if (recoveryWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, recoveryWaitMs));
    }
    return { mode, ok: true };
  } catch (err) {
    return { mode, ok: false, error: `${err}` };
  }
}

export function registerBrowserHarnessCommands({
  browser,
  deps,
  utils,
}: RegisterHarnessDeps): void {
  const {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    sessionTargetContext,
    durationToMs,
  } = utils;

  const harness = browser
    .command("harness")
    .description("run scripted browser automation plans with retries and reporting");

  harness
    .command("run")
    .description("run a JSON harness plan and write a structured report")
    .requiredOption("--plan <path>", "JSON harness plan file path (or '-' for stdin)")
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
      "--allow-raw-exec",
      "explicitly allow raw JS exec (sets policy.allow_raw_exec=true)",
    )
    .option(
      "--report-dir <path>",
      "directory to write harness artifacts/report (default ./.cocalc-browser-harness/<ts>)",
    )
    .option("--continue-on-error", "override plan to continue after failing steps")
    .option("--default-retries <n>", "default retries for steps missing retries", "1")
    .option(
      "--max-failures <n>",
      "halt run after this many failed steps (0 means unlimited; overrides plan.max_failures)",
    )
    .option(
      "--default-timeout <duration>",
      "default step timeout for steps missing timeout_ms (e.g. 30s, 2m)",
    )
    .option(
      "--default-recovery <none|reload|hard-reload>",
      "default recovery between retry attempts",
      "reload",
    )
    .option(
      "--recovery-wait <duration>",
      "wait duration after recovery action before retry",
      "1s",
    )
    .option("--screenshot-on-fail", "capture screenshot on failed attempts")
    .option("--no-screenshot-on-fail", "disable screenshot capture on failed attempts")
    .option("--logs-on-fail <n>", "capture latest runtime events on failed attempts", "120")
    .option("--network-on-fail <n>", "capture latest network trace events on failed attempts", "120")
    .option(
      "--network-include-decoded",
      "include decoded previews in network failure captures",
    )
    .option("--dry-run", "parse/normalize plan and return it without executing")
    .option(
      "--pin-target",
      "verify chosen browser session remains active during the run",
    )
    .option(
      "--no-pin-target",
      "disable active-session pin checks during the run",
    )
    .action(
      async (
        opts: {
          plan: string;
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
          reportDir?: string;
          continueOnError?: boolean;
          defaultRetries?: string;
          maxFailures?: string;
          defaultTimeout?: string;
          defaultRecovery?: string;
          recoveryWait?: string;
          screenshotOnFail?: boolean;
          logsOnFail?: string;
          networkOnFail?: string;
          networkIncludeDecoded?: boolean;
          dryRun?: boolean;
          pinTarget?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser harness run", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: true,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          let targetBrowserId = `${sessionInfo.browser_id ?? ""}`.trim();
          const pinnedSpawnMarker = spawnMarkerFromUrl(`${sessionInfo.url ?? ""}`) ?? "";
          const pinTarget = opts.pinTarget !== false;

          const assertPinnedSessionActive = async (): Promise<BrowserSessionInfo> => {
            const sessions = await ctx.hub.system.listBrowserSessions({
              include_stale: true,
            });
            const row = (sessions ?? []).find(
              (x) => `${x?.browser_id ?? ""}`.trim() === targetBrowserId,
            );
            if (!row) {
              if (pinnedSpawnMarker) {
                const remapped = (sessions ?? []).find(
                  (x) => !x?.stale && sessionMatchesSpawnMarker(x, pinnedSpawnMarker),
                );
                if (remapped) {
                  targetBrowserId = `${remapped.browser_id ?? ""}`.trim();
                  return remapped;
                }
              }
              throw new Error(`pinned browser session '${targetBrowserId}' is no longer present`);
            }
            if (row.stale) {
              if (pinnedSpawnMarker) {
                const remapped = (sessions ?? []).find(
                  (x) => !x?.stale && sessionMatchesSpawnMarker(x, pinnedSpawnMarker),
                );
                if (remapped) {
                  targetBrowserId = `${remapped.browser_id ?? ""}`.trim();
                  return remapped;
                }
              }
              throw new Error(
                `pinned browser session '${targetBrowserId}' is stale/inactive`,
              );
            }
            return row;
          };

          if (pinTarget) {
            await assertPinnedSessionActive();
          }

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
            allowRawExec: opts.allowRawExec,
            apiBaseUrl: ctx.apiBaseUrl,
          });

          const plan = await loadHarnessPlan(opts.plan);
          const defaultRetries = clampNonNegativeInt(
            opts.defaultRetries,
            1,
            "--default-retries",
          );
          const maxFailuresOverride =
            `${opts.maxFailures ?? ""}`.trim().length > 0
              ? clampNonNegativeInt(opts.maxFailures, 0, "--max-failures")
              : undefined;
          const defaultTimeoutMs = `${opts.defaultTimeout ?? ""}`.trim()
            ? Math.max(1_000, durationToMs(opts.defaultTimeout, ctx.timeoutMs))
            : undefined;
          const recoveryWaitMs = Math.max(0, durationToMs(opts.recoveryWait, 1_000));
          const defaultRecovery = parseRecoveryMode(opts.defaultRecovery, "reload");
          const continueOnError = !!opts.continueOnError;
          const captureDefaults: HarnessCapturePolicy = {
            screenshot_on_fail: opts.screenshotOnFail !== false,
            logs_on_fail: clampNonNegativeInt(opts.logsOnFail, 120, "--logs-on-fail"),
            network_on_fail: clampNonNegativeInt(
              opts.networkOnFail,
              120,
              "--network-on-fail",
            ),
            network_include_decoded: !!opts.networkIncludeDecoded,
          };

          const normalized = await normalizePlan({
            plan,
            defaultRetries,
            defaultTimeoutMs,
            defaultRecovery,
            defaultPauseMs: 0,
            maxFailuresOverride,
            continueOnError,
            captureDefaults,
          });

          const reportDir = resolvePath(
            `${opts.reportDir ?? ""}`.trim() ||
              `.cocalc-browser-harness/${new Date().toISOString().replace(/[:.]/g, "-")}`,
          );
          await mkdir(reportDir, { recursive: true });
          const reportPath = resolvePath(reportDir, "report.json");

          if (opts.dryRun) {
            const dryRunReport = {
              ok: true,
              dry_run: true,
              plan_path: resolvePath(`${opts.plan}`),
              report_dir: reportDir,
              posture,
              policy_allow_raw_exec: !!policy?.allow_raw_exec,
              normalized,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
            await writeJsonFile(reportPath, dryRunReport);
            return dryRunReport;
          }

          const startedAtMs = Date.now();
          const stepReports: StepReport[] = [];
          const signatureMap = new Map<string, FailureSignatureRow>();
          let halted = false;
          let failedSteps = 0;
          let reportIndex = 0;
          let consecutiveRpcTimeouts = 0;
          const rpcTimeoutBurstThreshold = 3;
          const maxFailures =
            normalized.max_failures == null || normalized.max_failures <= 0
              ? Number.POSITIVE_INFINITY
              : normalized.max_failures;
          const sleep = async (ms: number): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, ms));
          };
          const recoverAfterTimeoutBurst = async (): Promise<{
            ok: boolean;
            browser_id?: string;
            error?: string;
          }> => {
            const started = Date.now();
            const waitBudgetMs = Math.max(10_000, recoveryWaitMs * 6, 30_000);
            let lastErr = "";
            while (Date.now() - started <= waitBudgetMs) {
              try {
                let probeBrowserId = targetBrowserId;
                if (pinTarget) {
                  const pinned = await assertPinnedSessionActive();
                  probeBrowserId = `${pinned.browser_id ?? ""}`.trim() || probeBrowserId;
                }
                const probe = deps.createBrowserSessionClient({
                  account_id: ctx.accountId,
                  browser_id: probeBrowserId,
                  client: ctx.remote.client,
                  timeout: 4_000,
                });
                await probe.listRuntimeEvents({ limit: 1 });
                targetBrowserId = probeBrowserId;
                return {
                  ok: true,
                  browser_id: targetBrowserId,
                };
              } catch (err) {
                lastErr = `${err}`;
              }
              await sleep(750);
            }
            return {
              ok: false,
              error:
                lastErr ||
                `timed out waiting for browser session recovery after ${rpcTimeoutBurstThreshold} consecutive RPC timeouts`,
            };
          };

          const runStepList = async ({
            list,
            forceContinue,
          }: {
            list: NormalizedStep[];
            forceContinue: boolean;
          }): Promise<void> => {
            for (let i = 0; i < list.length; i += 1) {
              const step = list[i];
              const maxAttempts = step.retries + 1;
              const attemptReports: StepAttemptReport[] = [];
              let stepOk = false;
              let finalError = "";

              for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                if (pinTarget) {
                  await assertPinnedSessionActive();
                }
                const stepTimeout = Math.max(1_000, step.timeout_ms ?? ctx.timeoutMs);
                const browserClient = deps.createBrowserSessionClient({
                  account_id: ctx.accountId,
                  browser_id: targetBrowserId,
                  client: ctx.remote.client,
                  timeout: stepTimeout,
                });
                const attemptStarted = new Date().toISOString();
                const t0 = Date.now();
                const row: StepAttemptReport = {
                  attempt,
                  started_at: attemptStarted,
                  finished_at: attemptStarted,
                  duration_ms: 0,
                  ok: false,
                };
                try {
                  let result: unknown;
                  if (step.kind === "action") {
                    const response = await browserClient.action({
                      project_id,
                      posture,
                      policy,
                      action: step.action,
                    });
                    result = response?.result ?? null;
                  } else if (step.kind === "exec") {
                    let response;
                    try {
                      response = await browserClient.exec({
                        project_id,
                        code: step.code,
                        posture,
                        policy,
                      });
                    } catch (err) {
                      throw withBrowserExecStaleSessionHint({
                        err,
                        posture,
                        policy,
                        browserId: targetBrowserId,
                      });
                    }
                    result = response?.result ?? null;
                  } else if (step.kind === "assert") {
                    let response;
                    try {
                      response = await browserClient.exec({
                        project_id,
                        code: step.code,
                        posture,
                        policy,
                      });
                    } catch (err) {
                      throw withBrowserExecStaleSessionHint({
                        err,
                        posture,
                        policy,
                        browserId: targetBrowserId,
                      });
                    }
                    const got = response?.result;
                    if (step.expect_set) {
                      if (!isDeepStrictEqual(got, step.expect_value)) {
                        throw new Error(
                          `assert failed: expected ${inspect(step.expect_value, { depth: 4 })} but got ${inspect(got, { depth: 4 })}`,
                        );
                      }
                    } else {
                      const pass = step.truthy ? !!got : !got;
                      if (!pass) {
                        throw new Error(
                          `assert failed: expected ${step.truthy ? "truthy" : "falsy"} result, got ${inspect(got, { depth: 4 })}`,
                        );
                      }
                    }
                    result = { assertion_ok: true, value: got };
                  } else {
                    await new Promise((resolve) => setTimeout(resolve, step.sleep_ms));
                    result = { slept_ms: step.sleep_ms };
                  }
                  row.ok = true;
                  row.result = result;
                  stepOk = true;
                  consecutiveRpcTimeouts = 0;
                } catch (err) {
                  finalError = `${err}`;
                  row.error = finalError;
                  if (isRpcTimeoutError(err)) {
                    consecutiveRpcTimeouts += 1;
                    if (consecutiveRpcTimeouts >= rpcTimeoutBurstThreshold) {
                      const burstRecovery = await recoverAfterTimeoutBurst();
                      row.timeout_burst_recovery = {
                        threshold: rpcTimeoutBurstThreshold,
                        observed_consecutive: consecutiveRpcTimeouts,
                        ok: burstRecovery.ok,
                        ...(burstRecovery.browser_id
                          ? { browser_id: burstRecovery.browser_id }
                          : {}),
                        ...(burstRecovery.error ? { error: burstRecovery.error } : {}),
                      };
                      if (burstRecovery.ok) {
                        consecutiveRpcTimeouts = 0;
                      }
                    }
                  } else {
                    consecutiveRpcTimeouts = 0;
                  }
                  row.artifacts = await captureFailureArtifacts({
                    browserClient,
                    step,
                    reportDir,
                    stepIndex: reportIndex,
                    attempt,
                    project_id,
                    posture,
                    policy,
                  });
                  if (attempt < maxAttempts) {
                    row.recovery = await applyRecovery({
                      browserClient,
                      mode: step.recovery,
                      project_id,
                      posture,
                      policy,
                      recoveryWaitMs,
                    });
                  }
                }
                row.finished_at = new Date().toISOString();
                row.duration_ms = Date.now() - t0;
                attemptReports.push(row);
                if (stepOk) break;
              }

              const failureSignature =
                stepOk || !finalError
                  ? undefined
                  : normalizeFailureSignature({ step, error: finalError });
              if (failureSignature) {
                const prev = signatureMap.get(failureSignature);
                if (prev) {
                  prev.count += 1;
                  if (!prev.phases.includes(step.phase)) prev.phases.push(step.phase);
                  if (!prev.step_names.includes(step.name)) prev.step_names.push(step.name);
                  if (!prev.errors.includes(finalError)) prev.errors.push(finalError);
                } else {
                  signatureMap.set(failureSignature, {
                    signature: failureSignature,
                    count: 1,
                    phases: [step.phase],
                    step_names: [step.name],
                    errors: [finalError],
                  });
                }
              }

              stepReports.push({
                index: reportIndex,
                ...(step.id ? { id: step.id } : {}),
                name: step.name,
                phase: step.phase,
                kind: step.kind,
                ok: stepOk,
                attempts: attemptReports.length,
                ...(stepOk ? {} : { final_error: finalError || "step failed" }),
                ...(failureSignature ? { failure_signature: failureSignature } : {}),
                attempt_reports: attemptReports,
              });
              reportIndex += 1;

              if (!stepOk) {
                failedSteps += 1;
                if (failedSteps >= maxFailures) {
                  halted = true;
                  return;
                }
                if (!forceContinue && !step.continue_on_error) {
                  halted = true;
                  return;
                }
              }
              if (step.pause_ms > 0) {
                await new Promise((resolve) => setTimeout(resolve, step.pause_ms));
              }
            }
          };

          await runStepList({ list: normalized.before_steps, forceContinue: false });
          if (!halted) {
            await runStepList({ list: normalized.steps, forceContinue: false });
          }
          await runStepList({ list: normalized.after_steps, forceContinue: true });

          const finishedAtMs = Date.now();
          const passed = stepReports.filter((x) => x.ok).length;
          const failed = stepReports.length - passed;
          const ok = failed === 0 && !halted;
          const failureSignatures = Array.from(signatureMap.values())
            .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
            .map((x) => ({
              signature: x.signature,
              count: x.count,
              phases: x.phases,
              step_names: x.step_names,
              errors: x.errors,
            }));

          const report = {
            ok,
            name: normalized.name,
            plan_path: resolvePath(`${opts.plan}`),
            report_dir: reportDir,
            started_at: new Date(startedAtMs).toISOString(),
            finished_at: new Date(finishedAtMs).toISOString(),
            duration_ms: finishedAtMs - startedAtMs,
            steps_total:
              normalized.before_steps.length +
              normalized.steps.length +
              normalized.after_steps.length,
            steps_before_all_total: normalized.before_steps.length,
            steps_main_total: normalized.steps.length,
            steps_after_all_total: normalized.after_steps.length,
            steps_run: stepReports.length,
            steps_passed: passed,
            steps_failed: failed,
            halted_early: halted,
            max_failures: Number.isFinite(maxFailures) ? maxFailures : null,
            posture,
            policy_allow_raw_exec: !!policy?.allow_raw_exec,
            browser_id: targetBrowserId,
            project_id,
            pin_target: pinTarget,
            failure_signatures: failureSignatures,
            steps: stepReports,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };

          await writeJsonFile(reportPath, report);
          return {
            ...report,
            report_path: reportPath,
          };
        });
      },
    );
}
