#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_SCENARIOS = ["sign-in-target", "storage-archives"];
const INVITE_REDEEM_SCENARIO = "invite-redeem";
const INVITE_EDGE_CASES_SCENARIO = "invite-edge-cases";
const PROJECT_LIFECYCLE_SCENARIO = "project-lifecycle";
const RECONNECT_STABLE_URL_SCENARIO = "reconnect-stable-url";
const SIGN_UP_HOME_BAY_SCENARIO = "sign-up-home-bay";
const KNOWN_SCENARIOS = new Set([
  ...DEFAULT_SCENARIOS,
  INVITE_REDEEM_SCENARIO,
  INVITE_EDGE_CASES_SCENARIO,
  PROJECT_LIFECYCLE_SCENARIO,
  RECONNECT_STABLE_URL_SCENARIO,
  SIGN_UP_HOME_BAY_SCENARIO,
]);

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: node scripts/dev/multibay-browser-qa.mjs [options]",
      "",
      "Common inputs via flags or environment:",
      "  --base-url <url>           Stable public site URL, e.g. https://lite4b.cocalc.ai",
      "  --project <uuid>           Project id to open through the stable URL",
      "  --email <address>          Test account email for sign-in/storage scenarios",
      "  --password <password>      Test account password for sign-in/storage scenarios",
      "",
      "Options:",
      "  --project-title <text>     Visible project title to require after sign-in",
      "  --scenario <name>          Scenario to run; repeatable. Defaults to all.",
      "                            Known: sign-in-target, storage-archives, invite-redeem, invite-edge-cases, project-lifecycle, reconnect-stable-url, sign-up-home-bay",
      "  --registration-token <t>   Registration token for sign-up-home-bay when required",
      "  --expected-home-bay <id>   Assert created/signed-in account home bay, e.g. bay-2",
      "  --first-name <text>        First name for sign-up-home-bay (default: QA)",
      "  --last-name <text>         Last name for sign-up-home-bay (default: Multibay)",
      "  --owner-email <address>    Inviter account for invite scenarios; defaults to --email",
      "  --owner-password <pass>    Inviter password for invite scenarios; defaults to --password",
      "  --invitee-email <address>  Invitee account for invite scenarios",
      "  --invitee-password <pass>  Invitee password for invite scenarios",
      "  --invite-message <text>    Optional collaborator invite message",
      "  --invite-reset-before      Remove invitee collaborator before inviting, for disposable fixtures",
      "  --invite-cleanup-after     Remove invitee collaborator after validation",
      "  --chromium <path>          Chromium executable path (default: /usr/bin/chromium)",
      "  --timeout <ms>             Per-step timeout (default: 60000)",
      "  --headed                   Run Chromium visibly instead of headless",
      "  --fail-fast                Stop after the first scenario failure",
      "  --allow-empty-backups      Do not fail storage-archives when no backups exist",
      "  --allow-empty-snapshots    Do not fail storage-archives when no snapshots exist",
      "  --json                     Print only JSON result output",
      "  --help                     Show this help",
      "",
      "Environment aliases:",
      "  COCALC_MULTIBAY_QA_BASE_URL",
      "  COCALC_MULTIBAY_QA_PROJECT_ID",
      "  COCALC_MULTIBAY_QA_EMAIL",
      "  COCALC_MULTIBAY_QA_PASSWORD",
      "  COCALC_MULTIBAY_QA_OWNER_EMAIL",
      "  COCALC_MULTIBAY_QA_OWNER_PASSWORD",
      "  COCALC_MULTIBAY_QA_INVITEE_EMAIL",
      "  COCALC_MULTIBAY_QA_INVITEE_PASSWORD",
      "  COCALC_MULTIBAY_QA_INVITE_MESSAGE",
      "  COCALC_MULTIBAY_QA_INVITE_RESET_BEFORE",
      "  COCALC_MULTIBAY_QA_INVITE_CLEANUP_AFTER",
      "  COCALC_MULTIBAY_QA_PROJECT_TITLE",
      "  COCALC_MULTIBAY_QA_REGISTRATION_TOKEN",
      "  COCALC_MULTIBAY_QA_EXPECTED_HOME_BAY",
      "  COCALC_MULTIBAY_QA_FIRST_NAME",
      "  COCALC_MULTIBAY_QA_LAST_NAME",
      "  COCALC_MULTIBAY_QA_SCENARIOS",
      "  COCALC_MULTIBAY_QA_CHROMIUM",
      "  COCALC_MULTIBAY_QA_TIMEOUT_MS",
      "",
      "The password is only used for the browser form fill and is never printed.",
    ].join("\n"),
  );
  process.exit(code);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    usageAndExit(`${flag} requires a value`);
  }
  return value;
}

function envFlag(name) {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseScenarioList(value) {
  return `${value ?? ""}`
    .split(",")
    .map((scenario) => scenario.trim())
    .filter(Boolean);
}

function normalizeScenarios(scenarios) {
  const selected = scenarios.length === 0 ? DEFAULT_SCENARIOS : scenarios;
  const expanded = [];
  for (const scenario of selected) {
    if (scenario === "all") {
      expanded.push(...DEFAULT_SCENARIOS);
      continue;
    }
    if (!KNOWN_SCENARIOS.has(scenario)) {
      usageAndExit(
        `unknown scenario: ${scenario}. Known scenarios: ${[
          ...KNOWN_SCENARIOS,
        ].join(", ")}`,
      );
    }
    expanded.push(scenario);
  }
  return [...new Set(expanded)];
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COCALC_MULTIBAY_QA_BASE_URL ?? "",
    projectId: process.env.COCALC_MULTIBAY_QA_PROJECT_ID ?? "",
    email: process.env.COCALC_MULTIBAY_QA_EMAIL ?? "",
    password: process.env.COCALC_MULTIBAY_QA_PASSWORD ?? "",
    ownerEmail: process.env.COCALC_MULTIBAY_QA_OWNER_EMAIL ?? "",
    ownerPassword: process.env.COCALC_MULTIBAY_QA_OWNER_PASSWORD ?? "",
    inviteeEmail: process.env.COCALC_MULTIBAY_QA_INVITEE_EMAIL ?? "",
    inviteePassword: process.env.COCALC_MULTIBAY_QA_INVITEE_PASSWORD ?? "",
    inviteMessage:
      process.env.COCALC_MULTIBAY_QA_INVITE_MESSAGE ??
      "Multibay browser QA invite",
    projectTitle: process.env.COCALC_MULTIBAY_QA_PROJECT_TITLE ?? "",
    registrationToken: process.env.COCALC_MULTIBAY_QA_REGISTRATION_TOKEN ?? "",
    expectedHomeBay: process.env.COCALC_MULTIBAY_QA_EXPECTED_HOME_BAY ?? "",
    firstName: process.env.COCALC_MULTIBAY_QA_FIRST_NAME ?? "QA",
    lastName: process.env.COCALC_MULTIBAY_QA_LAST_NAME ?? "Multibay",
    scenarios: parseScenarioList(process.env.COCALC_MULTIBAY_QA_SCENARIOS),
    chromiumPath:
      process.env.COCALC_MULTIBAY_QA_CHROMIUM ??
      process.env.CHROMIUM_PATH ??
      "/usr/bin/chromium",
    timeoutMs: Number(process.env.COCALC_MULTIBAY_QA_TIMEOUT_MS ?? 60_000),
    headed: envFlag("COCALC_MULTIBAY_QA_HEADED"),
    failFast: envFlag("COCALC_MULTIBAY_QA_FAIL_FAST"),
    allowEmptyBackups: envFlag("COCALC_MULTIBAY_QA_ALLOW_EMPTY_BACKUPS"),
    allowEmptySnapshots: envFlag("COCALC_MULTIBAY_QA_ALLOW_EMPTY_SNAPSHOTS"),
    inviteResetBefore: envFlag("COCALC_MULTIBAY_QA_INVITE_RESET_BEFORE"),
    inviteCleanupAfter: envFlag("COCALC_MULTIBAY_QA_INVITE_CLEANUP_AFTER"),
    json: envFlag("COCALC_MULTIBAY_QA_JSON"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help") {
      usageAndExit("", 0);
    } else if (arg === "--base-url") {
      options.baseUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--project") {
      options.projectId = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--email") {
      options.email = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--password") {
      options.password = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--owner-email") {
      options.ownerEmail = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--owner-password") {
      options.ownerPassword = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--invitee-email") {
      options.inviteeEmail = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--invitee-password") {
      options.inviteePassword = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--invite-message") {
      options.inviteMessage = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--project-title") {
      options.projectTitle = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--registration-token") {
      options.registrationToken = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--expected-home-bay") {
      options.expectedHomeBay = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--first-name") {
      options.firstName = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--last-name") {
      options.lastName = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--scenario") {
      options.scenarios.push(...parseScenarioList(takeValue(argv, i, arg)));
      i += 1;
    } else if (arg === "--chromium") {
      options.chromiumPath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(takeValue(argv, i, arg));
      i += 1;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--fail-fast") {
      options.failFast = true;
    } else if (arg === "--allow-empty-backups") {
      options.allowEmptyBackups = true;
    } else if (arg === "--allow-empty-snapshots") {
      options.allowEmptySnapshots = true;
    } else if (arg === "--invite-reset-before") {
      options.inviteResetBefore = true;
    } else if (arg === "--invite-cleanup-after") {
      options.inviteCleanupAfter = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      usageAndExit(`unknown argument: ${arg}`);
    }
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  options.projectId = options.projectId.trim();
  options.email = options.email.trim();
  options.ownerEmail = options.ownerEmail.trim() || options.email;
  options.ownerPassword = options.ownerPassword || options.password;
  options.inviteeEmail = options.inviteeEmail.trim();
  options.registrationToken = options.registrationToken.trim();
  options.expectedHomeBay = options.expectedHomeBay.trim();
  options.firstName = options.firstName.trim() || "QA";
  options.lastName = options.lastName.trim() || "Multibay";
  options.scenarios = normalizeScenarios(options.scenarios);

  if (!options.baseUrl) usageAndExit("--base-url is required");
  if (
    options.scenarios.some((scenario) => scenario !== SIGN_UP_HOME_BAY_SCENARIO)
  ) {
    if (!options.projectId) usageAndExit("--project is required");
  }
  if (
    options.scenarios.some((scenario) =>
      [
        "sign-in-target",
        "storage-archives",
        PROJECT_LIFECYCLE_SCENARIO,
        RECONNECT_STABLE_URL_SCENARIO,
        SIGN_UP_HOME_BAY_SCENARIO,
      ].includes(scenario),
    )
  ) {
    if (!options.email) usageAndExit("--email is required");
    if (!options.password) usageAndExit("--password is required");
  }
  if (
    options.scenarios.some((scenario) =>
      [INVITE_REDEEM_SCENARIO, INVITE_EDGE_CASES_SCENARIO].includes(scenario),
    )
  ) {
    if (!options.ownerEmail) {
      usageAndExit("--owner-email is required for invite scenarios");
    }
    if (!options.ownerPassword) {
      usageAndExit("--owner-password is required for invite scenarios");
    }
    if (!options.inviteeEmail) {
      usageAndExit("--invitee-email is required for invite scenarios");
    }
    if (!options.inviteePassword) {
      usageAndExit("--invitee-password is required for invite scenarios");
    }
    if (options.ownerEmail === options.inviteeEmail) {
      usageAndExit("--owner-email and --invitee-email must be different");
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    usageAndExit("--timeout must be a positive number");
  }
  if (!existsSync(options.chromiumPath)) {
    usageAndExit(`chromium executable not found: ${options.chromiumPath}`);
  }

  try {
    const parsed = new URL(options.baseUrl);
    options.baseOrigin = parsed.origin;
  } catch {
    usageAndExit(`invalid --base-url: ${options.baseUrl}`);
  }

  return options;
}

function loadPlaywrightCore() {
  const candidates = [
    "playwright-core",
    path.join(SRC_ROOT, "packages/cli/node_modules/playwright-core"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next local install location.
    }
  }
  throw new Error(
    "Unable to load playwright-core. Run pnpm install in src or ensure packages/cli dependencies are installed.",
  );
}

function redact(value) {
  return `${value ?? ""}`
    .replace(
      /([?&](?:auth_token|password|token|key)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/g, "$1[redacted]");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bestEffortTimeout(label, promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`${label} timed out after ${timeoutMs}ms`);
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatError(error) {
  if (!error) return "unknown error";
  if (error.stack) return redact(error.stack);
  if (error.message) return redact(error.message);
  return redact(String(error));
}

function limitList(items, max = 20) {
  if (items.length <= max) return items;
  return [...items.slice(0, max), { omitted: items.length - max }];
}

function createDiagnostics(scenario) {
  return {
    scenario,
    console: [],
    pageErrors: [],
    failedRequests: [],
    authResponses: [],
  };
}

function attachDiagnostics(page, diagnostics, pageLabel = "") {
  page.on("console", (message) => {
    if (message.text().startsWith("multibay-qa:")) {
      console.warn(`${pageLabel}:${message.text()}`);
    }
    if (!["warning", "error"].includes(message.type())) return;
    diagnostics.console.push({
      page: pageLabel,
      type: message.type(),
      text: redact(message.text()),
      location: message.location(),
    });
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push({ page: pageLabel, error: formatError(error) });
  });
  page.on("requestfailed", (request) => {
    diagnostics.failedRequests.push({
      page: pageLabel,
      method: request.method(),
      url: redact(request.url()),
      error: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("response", (response) => {
    if (!response.url().includes("/api/v2/auth/sign-in")) return;
    diagnostics.authResponses.push({
      page: pageLabel,
      status: response.status(),
      url: redact(response.url()),
    });
  });
}

async function newQaPage(browser, options, diagnostics, pageLabel) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  page.setDefaultNavigationTimeout(options.timeoutMs);
  attachDiagnostics(page, diagnostics, pageLabel);
  return { context, page };
}

function summarizeDiagnostics(diagnostics) {
  return {
    console: limitList(diagnostics.console),
    pageErrors: limitList(diagnostics.pageErrors),
    failedRequests: limitList(diagnostics.failedRequests),
    authResponses: limitList(diagnostics.authResponses),
  };
}

async function assertNoStaleBuild(page) {
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  if (bodyText.includes("Stale Frontend Build Detected")) {
    throw new Error("stale frontend build interstitial is visible");
  }
}

async function waitForStableProjectUrl(page, options) {
  const projectPath = `/projects/${options.projectId}`;
  await page.waitForURL(
    (url) => url.origin === options.baseOrigin && url.pathname === projectPath,
    { timeout: options.timeoutMs },
  );
}

function primaryCredentials(options) {
  return {
    email: options.email,
    password: options.password,
  };
}

function ownerCredentials(options) {
  return {
    email: options.ownerEmail,
    password: options.ownerPassword,
  };
}

function inviteeCredentials(options) {
  return {
    email: options.inviteeEmail,
    password: options.inviteePassword,
  };
}

function getTargetFromHref(href, options) {
  if (!href) return "";
  try {
    return new URL(href, options.baseUrl).searchParams.get("target") ?? "";
  } catch {
    return "";
  }
}

async function fillAndSubmitSignIn(page, credentials) {
  await page.getByPlaceholder("you@example.com").fill(credentials.email);
  await page.getByPlaceholder("Password").fill(credentials.password);
  await page.getByRole("button", { name: /^Sign In$/i }).click();
}

async function signInToProject(
  page,
  options,
  credentials = primaryCredentials(options),
) {
  const projectPath = `/projects/${options.projectId}`;
  await page.goto(`${options.baseUrl}${projectPath}`, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await assertNoStaleBuild(page);

  const signInLink = page.getByRole("link", { name: /sign in/i }).first();
  await signInLink.waitFor({ state: "visible", timeout: options.timeoutMs });

  const href = await signInLink.getAttribute("href");
  const target = getTargetFromHref(href, options);
  if (target !== projectPath) {
    throw new Error(
      `sign-in link target mismatch: expected ${projectPath}, got ${target || "<empty>"}`,
    );
  }

  await signInLink.click();
  await page.waitForURL((url) => url.pathname === "/auth/sign-in", {
    timeout: options.timeoutMs,
  });

  const signInTarget = new URL(page.url()).searchParams.get("target");
  if (signInTarget !== projectPath) {
    throw new Error(
      `sign-in page target mismatch: expected ${projectPath}, got ${signInTarget || "<empty>"}`,
    );
  }

  await fillAndSubmitSignIn(page, credentials);

  await waitForStableProjectUrl(page, options);
  await assertNoStaleBuild(page);

  if (options.projectTitle) {
    await page.waitForFunction(
      (title) => document.body?.innerText?.includes(title),
      options.projectTitle,
      { timeout: options.timeoutMs },
    );
  }

  return {
    finalUrl: redact(page.url()),
    signInHref: redact(href),
    target: projectPath,
  };
}

async function signInToRoot(page, options, credentials) {
  await page.goto(`${options.baseUrl}/auth/sign-in?target=%2Fapp`, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await assertNoStaleBuild(page);
  await fillAndSubmitSignIn(page, credentials);
  await page.waitForURL(
    (url) =>
      url.origin === options.baseOrigin && !url.pathname.startsWith("/auth"),
    { timeout: options.timeoutMs },
  );
  await assertNoStaleBuild(page);
  await waitForRuntime(page, options);
  return { finalUrl: redact(page.url()), target: "/app" };
}

async function waitForRuntime(page, options) {
  await page.waitForFunction(
    () =>
      Boolean(
        globalThis.cc?.conat?.hub?.projects &&
        typeof globalThis.cc?.conat?.conat === "function",
      ),
    undefined,
    { timeout: options.timeoutMs },
  );
}

async function readProjectStateAfterRoutedReconnect(page, options, label) {
  await waitForRuntime(page, options);
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      return await page.evaluate(
        async ({ projectId, timeoutMs, label }) => {
          function toPlain(value) {
            return JSON.parse(JSON.stringify(value ?? null));
          }

          let timer;
          try {
            const state = await Promise.race([
              globalThis.cc.conat.hub.projects.getProjectState({
                project_id: projectId,
              }),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `${label}: getProjectState timed out after ${timeoutMs}ms`,
                      ),
                    ),
                  timeoutMs,
                );
              }),
            ]);
            return toPlain(state);
          } finally {
            clearTimeout(timer);
          }
        },
        { projectId: options.projectId, timeoutMs: options.timeoutMs, label },
      );
    } catch (error) {
      lastError = formatError(error);
      await sleep(1_000);
    }
  }
  throw new Error(
    `${label}: unable to read routed project state after reconnect; last error: ${lastError}`,
  );
}

async function runReconnectStableUrl(page, context, options) {
  const before = await readProjectStateAfterRoutedReconnect(
    page,
    options,
    "before-reconnect",
  );
  const beforeUrl = page.url();

  await context.setOffline(true);
  await sleep(Math.min(3_000, Math.max(1_000, options.timeoutMs / 20)));
  await context.setOffline(false);

  await waitForStableProjectUrl(page, options);
  const after = await readProjectStateAfterRoutedReconnect(
    page,
    options,
    "after-reconnect",
  );
  const afterUrl = page.url();

  if (new URL(afterUrl).origin !== options.baseOrigin) {
    throw new Error(
      `reconnect changed origin: expected ${options.baseOrigin}, got ${afterUrl}`,
    );
  }

  return {
    beforeUrl: redact(beforeUrl),
    afterUrl: redact(afterUrl),
    beforeState: before,
    afterState: after,
  };
}

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number; got ${value}`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

async function readStorageArchives(page, options) {
  await waitForRuntime(page, options);
  const result = await page.evaluate(
    async ({
      projectId,
      timeoutMs,
      allowEmptyBackups,
      allowEmptySnapshots,
    }) => {
      function toPlain(value) {
        return JSON.parse(JSON.stringify(value ?? null));
      }

      async function withTimeout(label, promise, timeout = timeoutMs) {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`${label} timed out after ${timeout}ms`)),
                timeout,
              );
            }),
          ]);
        } catch (err) {
          throw new Error(`${label} failed: ${err}`);
        } finally {
          clearTimeout(timer);
        }
      }

      const hubProjects = globalThis.cc.conat.hub.projects;
      const conatClient = globalThis.cc.conat.conat();
      const storage = conatClient.call(`project.${projectId}.storage-info.-`);

      const projectState = await withTimeout(
        "getProjectState",
        hubProjects.getProjectState({ project_id: projectId }),
      );
      const quota = await withTimeout("getQuota", storage.getQuota());
      const overview = await withTimeout(
        "getOverview",
        storage.getOverview({ force_sample: false }),
      );
      const snapshots = await withTimeout(
        "getSnapshotUsage",
        storage.getSnapshotUsage(),
      );
      const backups = await withTimeout(
        "getBackups",
        hubProjects.getBackups({ project_id: projectId }),
      );

      if (!allowEmptySnapshots && snapshots.length === 0) {
        throw new Error("no snapshots returned by getSnapshotUsage");
      }
      if (!allowEmptyBackups && backups.length === 0) {
        throw new Error("no backups returned by getBackups");
      }

      let firstBackupFiles = null;
      if (backups.length > 0) {
        firstBackupFiles = await withTimeout(
          "getBackupFiles",
          hubProjects.getBackupFiles({
            project_id: projectId,
            id: backups[0].id,
            path: "",
          }),
        );
      }

      return toPlain({
        projectState,
        quota,
        overview,
        snapshots,
        backups,
        firstBackupFiles,
      });
    },
    {
      projectId: options.projectId,
      timeoutMs: options.timeoutMs,
      allowEmptyBackups: options.allowEmptyBackups,
      allowEmptySnapshots: options.allowEmptySnapshots,
    },
  );

  assertFiniteNumber(result?.quota?.used, "quota.used");
  assertFiniteNumber(result?.quota?.size, "quota.size");
  assertArray(result?.snapshots, "snapshots");
  assertArray(result?.backups, "backups");
  if (result.backups.length > 0) {
    assertArray(result?.firstBackupFiles, "firstBackupFiles");
  }

  return {
    projectState: result.projectState,
    quota: {
      used: result.quota.used,
      size: result.quota.size,
      scope: result.quota.scope,
      qgroupid: result.quota.qgroupid,
    },
    overviewCounts: {
      quotas: result.overview?.quotas?.length ?? 0,
      visible: result.overview?.visible?.length ?? 0,
      counted: result.overview?.counted?.length ?? 0,
    },
    snapshotCount: result.snapshots.length,
    backupCount: result.backups.length,
    firstBackupId: result.backups[0]?.id ?? null,
    firstBackupFileCount: result.firstBackupFiles?.length ?? null,
  };
}

async function runProjectLifecycle(page, options) {
  await waitForRuntime(page, options);
  const result = await page.evaluate(
    async ({ projectId, timeoutMs }) => {
      function progress(label) {
        console.warn(`multibay-qa: lifecycle ${label}`);
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function toPlain(value) {
        return JSON.parse(JSON.stringify(value ?? null));
      }

      async function withTimeout(label, promise, timeout = timeoutMs) {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`${label} timed out after ${timeout}ms`)),
                timeout,
              );
            }),
          ]);
        } catch (err) {
          throw new Error(`${label} failed: ${err}`);
        } finally {
          clearTimeout(timer);
        }
      }

      const conat = globalThis.cc.conat;
      const hubProjects = conat.hub.projects;

      async function getState() {
        return await withTimeout(
          "getProjectState",
          hubProjects.getProjectState({ project_id: projectId }),
        );
      }

      async function waitForState(label, predicate) {
        const deadline = Date.now() + timeoutMs;
        let lastState = null;
        while (Date.now() < deadline) {
          lastState = await getState();
          if (predicate(lastState)) {
            return toPlain(lastState);
          }
          await sleep(1_000);
        }
        throw new Error(
          `${label} timed out after ${timeoutMs}ms; last state=${JSON.stringify(lastState)}`,
        );
      }

      async function waitForLro(label, op) {
        if (typeof conat.lroWait !== "function") {
          return null;
        }
        const summary = await withTimeout(
          label,
          conat.lroWait({
            op_id: op.op_id,
            stream_name: op.stream_name,
            scope_type: op.scope_type,
            scope_id: op.scope_id,
            timeout_ms: timeoutMs,
          }),
        );
        if (summary?.status !== "succeeded") {
          throw new Error(
            `${label} finished with status ${summary?.status ?? "<missing>"}`,
          );
        }
        return toPlain(summary);
      }

      async function startAndWait(label) {
        const op = await withTimeout(
          `${label}:start`,
          hubProjects.start({ project_id: projectId, wait: false }),
        );
        const summary = await waitForLro(`${label}:lro`, op).catch(
          async () => null,
        );
        const state = await waitForState(
          `${label}:running`,
          (candidate) => candidate?.state === "running",
        );
        return { op: toPlain(op), summary, state };
      }

      async function stopAndWait() {
        await withTimeout("stop", hubProjects.stop({ project_id: projectId }));
        return await waitForState(
          "stop:non-running",
          (candidate) => candidate?.state !== "running",
        );
      }

      async function restartAndWait() {
        const op = await withTimeout(
          "restart",
          hubProjects.restart({ project_id: projectId, wait: false }),
        );
        const summary = await waitForLro("restart:lro", op).catch(
          async () => null,
        );
        const state = await waitForState(
          "restart:running",
          (candidate) => candidate?.state === "running",
        );
        return { op: toPlain(op), summary, state };
      }

      async function terminalSmoke(label) {
        if (typeof conat.terminalClient !== "function") {
          throw new Error("cc.conat.terminalClient is not available");
        }
        const marker = `multibay_lifecycle_${label}_${Date.now()}`;
        const path = `.smoke/${marker}.txt`;
        const term = conat.terminalClient({ project_id: projectId });
        try {
          const spawnHistory = `${await withTimeout(
            `${label}:terminal-spawn`,
            term.spawn(
              "bash",
              [
                "-lc",
                `mkdir -p .smoke && printf '%s\\n' '${marker}' > '${path}' && cat '${path}' && sleep 5`,
              ],
              {
                id: `.smoke/${marker}.term`,
                timeout: timeoutMs,
                rows: 24,
                cols: 80,
              },
            ),
          )}`;
          if (spawnHistory.includes(marker)) {
            return { marker, path, historyLength: spawnHistory.length };
          }
          const deadline = Date.now() + timeoutMs;
          let history = "";
          while (Date.now() < deadline) {
            history = `${await withTimeout(`${label}:terminal-history`, term.history())}`;
            if (history.includes(marker)) {
              return { marker, path, historyLength: history.length };
            }
            await sleep(500);
          }
          throw new Error(
            `${label}: terminal marker not observed; spawn_history=${JSON.stringify(spawnHistory.slice(-500))}; last_history=${JSON.stringify(history.slice(-500))}`,
          );
        } finally {
          try {
            await withTimeout(
              `${label}:terminal-destroy`,
              Promise.resolve(term.destroy()),
              5_000,
            );
          } catch {
            // Terminal cleanup is best-effort; close below tears down the socket.
          }
          try {
            term.close();
          } catch {
            // Nothing actionable; the browser context will close after the scenario.
          }
        }
      }

      const initialState = await getState();
      try {
        progress("start:start");
        const start = await startAndWait("start");
        progress("start:terminal");
        const terminalAfterStart = await terminalSmoke("start");
        progress("restart:start");
        const restart = await restartAndWait();
        progress("restart:terminal");
        const terminalAfterRestart = await terminalSmoke("restart");
        progress("stop:start");
        const stoppedState = await stopAndWait();
        progress("final-start:start");
        const finalStart = await startAndWait("final-start");
        progress("done");

        return toPlain({
          initialState,
          start,
          terminalAfterStart,
          restart,
          terminalAfterRestart,
          stoppedState,
          finalStart,
        });
      } catch (err) {
        try {
          const state = await getState();
          if (state?.state !== "running") {
            await startAndWait("failure-recovery-start");
          }
        } catch (recoveryErr) {
          throw new Error(`${err}; recovery start failed: ${recoveryErr}`);
        }
        throw err;
      }
    },
    { projectId: options.projectId, timeoutMs: options.timeoutMs },
  );

  if (result?.start?.state?.state !== "running") {
    throw new Error("project did not reach running after start");
  }
  if (result?.restart?.state?.state !== "running") {
    throw new Error("project did not reach running after restart");
  }
  if (result?.finalStart?.state?.state !== "running") {
    throw new Error("project did not reach running after final start");
  }
  if (!result?.terminalAfterStart?.marker) {
    throw new Error("missing terminal marker after start");
  }
  if (!result?.terminalAfterRestart?.marker) {
    throw new Error("missing terminal marker after restart");
  }

  return result;
}

async function getSignedInAccountId(page, options) {
  await waitForRuntime(page, options);
  const accountId = await page.evaluate(() => {
    const clientAccountId = globalThis.cc?.client?.account_id;
    if (typeof clientAccountId === "string" && clientAccountId) {
      return clientAccountId;
    }
    const storeAccountId = globalThis.cc?.redux
      ?.getStore?.("account")
      ?.get?.("account_id");
    return typeof storeAccountId === "string" ? storeAccountId : "";
  });
  if (!accountId) {
    throw new Error("unable to determine signed-in account id");
  }
  return accountId;
}

async function getSignedInAccountHomeBay(page, options, accountId) {
  await waitForRuntime(page, options);
  const location = await page.evaluate(
    async (userAccountId) =>
      await globalThis.cc.conat.hub.system.getAccountBay({
        user_account_id: userAccountId,
      }),
    accountId,
  );
  const homeBayId = `${location?.home_bay_id ?? ""}`.trim();
  if (!homeBayId) {
    throw new Error("unable to determine signed-in account home bay");
  }
  return location;
}

async function signUpThroughStableUrl(page, options) {
  const signUpUrl = new URL("/auth/sign-up", options.baseUrl);
  if (options.registrationToken) {
    signUpUrl.searchParams.set("registrationToken", options.registrationToken);
  }
  await page.goto(signUpUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await assertNoStaleBuild(page);

  const registrationTokenInput = page.getByPlaceholder(
    "Enter your registration token",
  );
  if ((await registrationTokenInput.count()) > 0) {
    await registrationTokenInput.fill(options.registrationToken);
  }
  await page.getByPlaceholder("you@example.com").fill(options.email);
  await page.locator('input[type="password"]').fill(options.password);
  await page.getByPlaceholder("First name").fill(options.firstName);
  await page.getByPlaceholder("Last name").fill(options.lastName);
  await page.getByRole("button", { name: /^Create account$/i }).click();

  await page.waitForURL(
    (url) =>
      url.origin === options.baseOrigin && !url.pathname.startsWith("/auth"),
    { timeout: options.timeoutMs },
  );
  await assertNoStaleBuild(page);
  await waitForRuntime(page, options);
  const accountId = await getSignedInAccountId(page, options);
  const homeBay = await getSignedInAccountHomeBay(page, options, accountId);
  if (
    options.expectedHomeBay &&
    homeBay.home_bay_id !== options.expectedHomeBay
  ) {
    throw new Error(
      `created account home bay mismatch: expected ${options.expectedHomeBay}, got ${homeBay.home_bay_id}`,
    );
  }
  return {
    finalUrl: redact(page.url()),
    accountId,
    homeBay,
  };
}

async function runSignUpHomeBayScenario(browser, options) {
  const diagnostics = createDiagnostics(SIGN_UP_HOME_BAY_SCENARIO);
  const contexts = [];

  try {
    const signUp = await newQaPage(browser, options, diagnostics, "sign-up");
    contexts.push(signUp.context);
    const signUpResult = await signUpThroughStableUrl(signUp.page, options);

    const signIn = await newQaPage(browser, options, diagnostics, "sign-in");
    contexts.push(signIn.context);
    const signInResult = await signInToRoot(
      signIn.page,
      options,
      primaryCredentials(options),
    );
    const signedInAccountId = await getSignedInAccountId(signIn.page, options);
    if (signedInAccountId !== signUpResult.accountId) {
      throw new Error(
        `fresh sign-in account mismatch: expected ${signUpResult.accountId}, got ${signedInAccountId}`,
      );
    }
    const signedInHomeBay = await getSignedInAccountHomeBay(
      signIn.page,
      options,
      signedInAccountId,
    );
    if (
      options.expectedHomeBay &&
      signedInHomeBay.home_bay_id !== options.expectedHomeBay
    ) {
      throw new Error(
        `fresh sign-in home bay mismatch: expected ${options.expectedHomeBay}, got ${signedInHomeBay.home_bay_id}`,
      );
    }

    return {
      scenario: SIGN_UP_HOME_BAY_SCENARIO,
      status: "pass",
      signUp: signUpResult,
      signIn: {
        ...signInResult,
        accountId: signedInAccountId,
        homeBay: signedInHomeBay,
      },
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } catch (error) {
    return {
      scenario: SIGN_UP_HOME_BAY_SCENARIO,
      status: "fail",
      error: formatError(error),
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } finally {
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );
  }
}

async function listCollaborators(page, options) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ projectId }) =>
      await globalThis.cc.conat.hub.projects.listCollaborators({
        project_id: projectId,
      }),
    { projectId: options.projectId },
  );
}

async function isProjectCollaborator(page, options, accountId) {
  const collaborators = await listCollaborators(page, options);
  return collaborators.some(
    (collaborator) => collaborator.account_id === accountId,
  );
}

async function waitForCollaboratorState(page, options, accountId, expected) {
  const deadline = Date.now() + options.timeoutMs;
  let lastState = false;
  while (Date.now() < deadline) {
    lastState = await isProjectCollaborator(page, options, accountId);
    if (lastState === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `timed out waiting for invitee collaborator state ${expected}; last state was ${lastState}`,
  );
}

async function removeCollaboratorIfPresent(page, options, accountId) {
  const present = await isProjectCollaborator(page, options, accountId);
  if (!present) {
    return false;
  }
  await page.evaluate(
    async ({ projectId, accountId }) =>
      await globalThis.cc.conat.hub.projects.removeCollaborator({
        opts: { project_id: projectId, account_id: accountId },
      }),
    { projectId: options.projectId, accountId },
  );
  await waitForCollaboratorState(page, options, accountId, false);
  return true;
}

async function createCollaboratorInvite(page, options, inviteeAccountId) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ projectId, inviteeAccountId, message }) =>
      await globalThis.cc.conat.hub.projects.createCollabInvite({
        project_id: projectId,
        invitee_account_id: inviteeAccountId,
        message,
      }),
    {
      projectId: options.projectId,
      inviteeAccountId,
      message: options.inviteMessage,
    },
  );
}

async function revokeCollaboratorInvite(page, options, inviteId) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ inviteId, projectId }) =>
      await globalThis.cc.conat.hub.projects.respondCollabInvite({
        invite_id: inviteId,
        project_id: projectId,
        action: "revoke",
      }),
    { inviteId, projectId: options.projectId },
  );
}

async function listPendingInboundInvites(page, options) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ projectId }) =>
      await globalThis.cc.conat.hub.projects.listCollabInvites({
        project_id: projectId,
        direction: "inbound",
        status: "pending",
        limit: 50,
      }),
    { projectId: options.projectId },
  );
}

async function listPendingOutboundInvitesForInvitee(
  page,
  options,
  inviteeAccountId,
) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ projectId, inviteeAccountId }) => {
      const invites = await globalThis.cc.conat.hub.projects.listCollabInvites({
        project_id: projectId,
        direction: "outbound",
        status: "pending",
        limit: 100,
      });
      return invites.filter(
        (invite) => invite.invitee_account_id === inviteeAccountId,
      );
    },
    { projectId: options.projectId, inviteeAccountId },
  );
}

async function revokePendingOutboundInvitesForInvitee(
  page,
  options,
  inviteeAccountId,
) {
  const invites = await listPendingOutboundInvitesForInvitee(
    page,
    options,
    inviteeAccountId,
  );
  for (const invite of invites) {
    await revokeCollaboratorInvite(page, options, invite.invite_id);
  }
  return invites.map((invite) => invite.invite_id);
}

async function waitForInboundInvite(page, options, inviteId) {
  const deadline = Date.now() + options.timeoutMs;
  let lastInviteIds = [];
  while (Date.now() < deadline) {
    const invites = await listPendingInboundInvites(page, options);
    lastInviteIds = invites.map((invite) => invite.invite_id);
    const invite = invites.find(
      (candidate) => candidate.invite_id === inviteId,
    );
    if (invite) {
      return invite;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `timed out waiting for inbound invite ${inviteId}; pending invites=${lastInviteIds.join(",")}`,
  );
}

async function waitForInboundInviteAbsent(page, options, inviteId) {
  const deadline = Date.now() + options.timeoutMs;
  let present = false;
  while (Date.now() < deadline) {
    const invites = await listPendingInboundInvites(page, options);
    present = invites.some((candidate) => candidate.invite_id === inviteId);
    if (!present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `timed out waiting for inbound invite ${inviteId} to disappear; still present=${present}`,
  );
}

async function expectAlreadyCollaboratorInviteError(
  page,
  options,
  inviteeAccountId,
) {
  await waitForRuntime(page, options);
  const result = await page.evaluate(
    async ({ projectId, inviteeAccountId, message }) => {
      try {
        await globalThis.cc.conat.hub.projects.createCollabInvite({
          project_id: projectId,
          invitee_account_id: inviteeAccountId,
          message,
        });
        return { ok: true, error: "" };
      } catch (err) {
        return { ok: false, error: err?.message ?? `${err}` };
      }
    },
    {
      projectId: options.projectId,
      inviteeAccountId,
      message: options.inviteMessage,
    },
  );
  if (result.ok) {
    throw new Error("already-collaborator invite unexpectedly succeeded");
  }
  if (!/already a collaborator/i.test(result.error)) {
    throw new Error(
      `already-collaborator invite failed with unexpected error: ${result.error}`,
    );
  }
  return result.error;
}

async function acceptCollaboratorInvite(page, options, inviteId) {
  await waitForRuntime(page, options);
  return await page.evaluate(
    async ({ projectId, inviteId, timeoutMs }) => {
      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      const hubProjects = globalThis.cc.conat.hub.projects;
      const deadline = Date.now() + timeoutMs;
      let lastInviteIds = [];
      while (Date.now() < deadline) {
        const invites = await hubProjects.listCollabInvites({
          project_id: projectId,
          direction: "inbound",
          status: "pending",
          limit: 50,
        });
        lastInviteIds = invites.map((invite) => invite.invite_id);
        const invite = invites.find((candidate) =>
          inviteId ? candidate.invite_id === inviteId : true,
        );
        if (invite) {
          return await hubProjects.respondCollabInvite({
            invite_id: invite.invite_id,
            project_id: projectId,
            action: "accept",
          });
        }
        await sleep(1_000);
      }
      throw new Error(
        `timed out waiting for inbound invite ${inviteId}; pending invites=${lastInviteIds.join(",")}`,
      );
    },
    {
      projectId: options.projectId,
      inviteId,
      timeoutMs: options.timeoutMs,
    },
  );
}

async function openProjectAndVerify(page, options) {
  await page.goto(`${options.baseUrl}/projects/${options.projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await waitForStableProjectUrl(page, options);
  await assertNoStaleBuild(page);
  if (options.projectTitle) {
    await page.waitForFunction(
      (title) => document.body?.innerText?.includes(title),
      options.projectTitle,
      { timeout: options.timeoutMs },
    );
  }
  await waitForRuntime(page, options);
  return { finalUrl: redact(page.url()) };
}

async function runInviteRedeemScenario(browser, options) {
  const diagnostics = createDiagnostics(INVITE_REDEEM_SCENARIO);
  const contexts = [];
  let ownerPage;
  let inviteeAccountId = "";
  let accepted = false;
  let removedAfter = false;

  try {
    const owner = await newQaPage(browser, options, diagnostics, "owner");
    contexts.push(owner.context);
    ownerPage = owner.page;
    const ownerSignIn = await signInToProject(
      owner.page,
      options,
      ownerCredentials(options),
    );

    const invitee = await newQaPage(browser, options, diagnostics, "invitee");
    contexts.push(invitee.context);
    const inviteeSignIn = await signInToRoot(
      invitee.page,
      options,
      inviteeCredentials(options),
    );
    inviteeAccountId = await getSignedInAccountId(invitee.page, options);

    const removedBefore = options.inviteResetBefore
      ? await removeCollaboratorIfPresent(owner.page, options, inviteeAccountId)
      : false;

    const alreadyCollaborator = await isProjectCollaborator(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (alreadyCollaborator) {
      throw new Error(
        "invitee is already a collaborator; use --invite-reset-before with a disposable fixture or choose a non-collaborator invitee",
      );
    }

    const createdInvite = await createCollaboratorInvite(
      owner.page,
      options,
      inviteeAccountId,
    );
    const acceptedInvite = await acceptCollaboratorInvite(
      invitee.page,
      options,
      createdInvite?.invite?.invite_id,
    );
    accepted = true;
    await waitForCollaboratorState(
      invitee.page,
      options,
      inviteeAccountId,
      true,
    );
    const projectOpen = await openProjectAndVerify(invitee.page, options);

    if (options.inviteCleanupAfter) {
      removedAfter = await removeCollaboratorIfPresent(
        owner.page,
        options,
        inviteeAccountId,
      );
    }

    return {
      scenario: INVITE_REDEEM_SCENARIO,
      status: "pass",
      inviteRedeem: {
        ownerSignIn,
        inviteeSignIn,
        inviteeAccountId,
        removedBefore,
        removedAfter,
        created: Boolean(createdInvite?.created),
        inviteId: createdInvite?.invite?.invite_id ?? null,
        acceptedStatus: acceptedInvite?.status ?? null,
        finalUrl: projectOpen.finalUrl,
      },
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } catch (error) {
    if (
      options.inviteCleanupAfter &&
      accepted &&
      ownerPage &&
      inviteeAccountId
    ) {
      try {
        removedAfter = await removeCollaboratorIfPresent(
          ownerPage,
          options,
          inviteeAccountId,
        );
      } catch {
        // Preserve the original failure; cleanup is best-effort in failure paths.
      }
    }
    return {
      scenario: INVITE_REDEEM_SCENARIO,
      status: "fail",
      error: formatError(error),
      inviteRedeem: {
        inviteeAccountId: inviteeAccountId || null,
        removedAfter,
      },
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } finally {
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );
  }
}

async function runInviteEdgeCasesScenario(browser, options) {
  const diagnostics = createDiagnostics(INVITE_EDGE_CASES_SCENARIO);
  const contexts = [];
  let ownerPage;
  let inviteePage;
  let inviteeAccountId = "";
  let finalCollaborator = false;
  let removedAfter = false;

  try {
    const owner = await newQaPage(browser, options, diagnostics, "owner");
    contexts.push(owner.context);
    ownerPage = owner.page;
    const ownerSignIn = await signInToProject(
      owner.page,
      options,
      ownerCredentials(options),
    );

    const invitee = await newQaPage(browser, options, diagnostics, "invitee");
    contexts.push(invitee.context);
    inviteePage = invitee.page;
    const inviteeSignIn = await signInToRoot(
      invitee.page,
      options,
      inviteeCredentials(options),
    );
    inviteeAccountId = await getSignedInAccountId(invitee.page, options);

    const removedBefore = await removeCollaboratorIfPresent(
      owner.page,
      options,
      inviteeAccountId,
    );
    const revokedBefore = await revokePendingOutboundInvitesForInvitee(
      owner.page,
      options,
      inviteeAccountId,
    );

    const firstInvite = await createCollaboratorInvite(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (!firstInvite?.created) {
      throw new Error("initial invite did not create a new pending invite");
    }
    const firstInviteId = firstInvite.invite?.invite_id;
    if (!firstInviteId) {
      throw new Error("initial invite response is missing invite_id");
    }
    await waitForInboundInvite(invitee.page, options, firstInviteId);

    const duplicateInvite = await createCollaboratorInvite(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (duplicateInvite?.created !== false) {
      throw new Error("duplicate invite did not return created=false");
    }
    if (duplicateInvite?.invite?.invite_id !== firstInviteId) {
      throw new Error(
        `duplicate invite id mismatch: expected ${firstInviteId}, got ${duplicateInvite?.invite?.invite_id ?? "<missing>"}`,
      );
    }

    const revokedInvite = await revokeCollaboratorInvite(
      owner.page,
      options,
      firstInviteId,
    );
    if (revokedInvite?.status !== "canceled") {
      throw new Error(
        `revoked invite status mismatch: expected canceled, got ${revokedInvite?.status ?? "<missing>"}`,
      );
    }
    await waitForInboundInviteAbsent(invitee.page, options, firstInviteId);

    const secondInvite = await createCollaboratorInvite(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (!secondInvite?.created) {
      throw new Error("post-revoke invite did not create a new pending invite");
    }
    const secondInviteId = secondInvite.invite?.invite_id;
    if (!secondInviteId) {
      throw new Error("post-revoke invite response is missing invite_id");
    }
    if (secondInviteId === firstInviteId) {
      throw new Error("post-revoke invite reused the revoked invite id");
    }

    const acceptedInvite = await acceptCollaboratorInvite(
      invitee.page,
      options,
      secondInviteId,
    );
    await waitForCollaboratorState(owner.page, options, inviteeAccountId, true);
    const projectOpenAfterAccept = await openProjectAndVerify(
      invitee.page,
      options,
    );

    const alreadyCollaboratorError = await expectAlreadyCollaboratorInviteError(
      owner.page,
      options,
      inviteeAccountId,
    );

    const removedAfterAccept = await removeCollaboratorIfPresent(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (!removedAfterAccept) {
      throw new Error("remove collaborator after accept did not remove anyone");
    }

    const thirdInvite = await createCollaboratorInvite(
      owner.page,
      options,
      inviteeAccountId,
    );
    if (!thirdInvite?.created) {
      throw new Error("post-remove invite did not create a new pending invite");
    }
    const thirdInviteId = thirdInvite.invite?.invite_id;
    if (!thirdInviteId) {
      throw new Error("post-remove invite response is missing invite_id");
    }

    const acceptedAfterRemove = await acceptCollaboratorInvite(
      invitee.page,
      options,
      thirdInviteId,
    );
    await waitForCollaboratorState(owner.page, options, inviteeAccountId, true);
    const projectOpenAfterReaccept = await openProjectAndVerify(
      invitee.page,
      options,
    );
    finalCollaborator = true;

    if (options.inviteCleanupAfter) {
      removedAfter = await removeCollaboratorIfPresent(
        owner.page,
        options,
        inviteeAccountId,
      );
      finalCollaborator = !removedAfter;
    }

    return {
      scenario: INVITE_EDGE_CASES_SCENARIO,
      status: "pass",
      inviteEdgeCases: {
        ownerSignIn,
        inviteeSignIn,
        inviteeAccountId,
        removedBefore,
        revokedBefore,
        duplicateCreated: duplicateInvite.created,
        firstInviteId,
        revokedStatus: revokedInvite.status,
        secondInviteId,
        acceptedStatus: acceptedInvite?.status ?? null,
        alreadyCollaboratorError,
        removedAfterAccept,
        thirdInviteId,
        acceptedAfterRemoveStatus: acceptedAfterRemove?.status ?? null,
        finalCollaborator,
        removedAfter,
        finalUrl:
          projectOpenAfterReaccept.finalUrl ?? projectOpenAfterAccept.finalUrl,
      },
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } catch (error) {
    if (
      options.inviteCleanupAfter &&
      finalCollaborator &&
      ownerPage &&
      inviteeAccountId
    ) {
      try {
        removedAfter = await removeCollaboratorIfPresent(
          ownerPage,
          options,
          inviteeAccountId,
        );
      } catch {
        // Preserve the original failure; cleanup is best-effort in failure paths.
      }
    }
    return {
      scenario: INVITE_EDGE_CASES_SCENARIO,
      status: "fail",
      error: formatError(error),
      inviteEdgeCases: {
        inviteeAccountId: inviteeAccountId || null,
        finalCollaborator,
        removedAfter,
        currentInviteeUrl: inviteePage ? redact(inviteePage.url()) : null,
      },
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } finally {
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );
  }
}

async function runScenario(browser, scenario, options) {
  if (scenario === SIGN_UP_HOME_BAY_SCENARIO) {
    return await runSignUpHomeBayScenario(browser, options);
  }
  if (scenario === INVITE_REDEEM_SCENARIO) {
    return await runInviteRedeemScenario(browser, options);
  }
  if (scenario === INVITE_EDGE_CASES_SCENARIO) {
    return await runInviteEdgeCasesScenario(browser, options);
  }

  const diagnostics = createDiagnostics(scenario);
  const { context, page } = await newQaPage(
    browser,
    options,
    diagnostics,
    scenario,
  );

  try {
    if (scenario === "sign-in-target") {
      const signIn = await signInToProject(page, options);
      return {
        scenario,
        status: "pass",
        signIn,
        diagnostics: summarizeDiagnostics(diagnostics),
      };
    }
    if (scenario === "storage-archives") {
      const signIn = await signInToProject(page, options);
      const storageArchives = await readStorageArchives(page, options);
      return {
        scenario,
        status: "pass",
        signIn,
        storageArchives,
        diagnostics: summarizeDiagnostics(diagnostics),
      };
    }
    if (scenario === PROJECT_LIFECYCLE_SCENARIO) {
      const signIn = await signInToProject(page, options);
      const lifecycle = await runProjectLifecycle(page, options);
      return {
        scenario,
        status: "pass",
        signIn,
        lifecycle,
        diagnostics: summarizeDiagnostics(diagnostics),
      };
    }
    if (scenario === RECONNECT_STABLE_URL_SCENARIO) {
      const signIn = await signInToProject(page, options);
      const reconnect = await runReconnectStableUrl(page, context, options);
      return {
        scenario,
        status: "pass",
        signIn,
        reconnect,
        diagnostics: summarizeDiagnostics(diagnostics),
      };
    }
    throw new Error(`unhandled scenario: ${scenario}`);
  } catch (error) {
    return {
      scenario,
      status: "fail",
      error: formatError(error),
      currentUrl: redact(page.url()),
      diagnostics: summarizeDiagnostics(diagnostics),
    };
  } finally {
    await bestEffortTimeout(
      `${scenario}:context.close`,
      context.close().catch(() => {}),
      5_000,
    );
  }
}

function printTextResult(result) {
  const prefix = result.status === "pass" ? "PASS" : "FAIL";
  if (result.scenario === "sign-in-target") {
    console.log(
      `${prefix} sign-in-target final_url=${result.signIn?.finalUrl ?? result.currentUrl ?? "<unknown>"}`,
    );
  } else if (result.scenario === "storage-archives") {
    const storage = result.storageArchives;
    console.log(
      [
        `${prefix} storage-archives`,
        `final_url=${result.signIn?.finalUrl ?? result.currentUrl ?? "<unknown>"}`,
        storage
          ? `quota=${storage.quota.used}/${storage.quota.size}`
          : "quota=<unavailable>",
        storage
          ? `snapshots=${storage.snapshotCount}`
          : "snapshots=<unavailable>",
        storage ? `backups=${storage.backupCount}` : "backups=<unavailable>",
        storage?.firstBackupFileCount != null
          ? `first_backup_files=${storage.firstBackupFileCount}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (result.scenario === INVITE_REDEEM_SCENARIO) {
    const invite = result.inviteRedeem;
    console.log(
      [
        `${prefix} invite-redeem`,
        `final_url=${invite?.finalUrl ?? result.currentUrl ?? "<unknown>"}`,
        invite?.inviteId ? `invite=${invite.inviteId}` : "",
        invite?.acceptedStatus
          ? `accepted_status=${invite.acceptedStatus}`
          : "",
        invite?.removedBefore ? "removed_before=1" : "removed_before=0",
        invite?.removedAfter ? "removed_after=1" : "removed_after=0",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (result.scenario === INVITE_EDGE_CASES_SCENARIO) {
    const invite = result.inviteEdgeCases;
    console.log(
      [
        `${prefix} invite-edge-cases`,
        `final_url=${invite?.finalUrl ?? result.currentUrl ?? "<unknown>"}`,
        invite?.firstInviteId ? `first=${invite.firstInviteId}` : "",
        invite?.secondInviteId ? `second=${invite.secondInviteId}` : "",
        invite?.thirdInviteId ? `third=${invite.thirdInviteId}` : "",
        invite?.revokedBefore?.length
          ? `revoked_before=${invite.revokedBefore.length}`
          : "revoked_before=0",
        invite?.duplicateCreated === false ? "duplicate_created=0" : "",
        invite?.revokedStatus ? `revoked=${invite.revokedStatus}` : "",
        invite?.acceptedStatus
          ? `accepted_status=${invite.acceptedStatus}`
          : "",
        invite?.acceptedAfterRemoveStatus
          ? `reaccepted_status=${invite.acceptedAfterRemoveStatus}`
          : "",
        invite?.alreadyCollaboratorError ? "already_collaborator_error=1" : "",
        invite?.removedAfterAccept ? "removed_after_accept=1" : "",
        invite?.finalCollaborator ? "final_collaborator=1" : "",
        invite?.removedAfter ? "removed_after=1" : "removed_after=0",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (result.scenario === PROJECT_LIFECYCLE_SCENARIO) {
    const lifecycle = result.lifecycle;
    console.log(
      [
        `${prefix} project-lifecycle`,
        `final_url=${result.signIn?.finalUrl ?? result.currentUrl ?? "<unknown>"}`,
        lifecycle?.initialState?.state
          ? `initial=${lifecycle.initialState.state}`
          : "",
        lifecycle?.stoppedState?.state
          ? `stopped=${lifecycle.stoppedState.state}`
          : "",
        lifecycle?.finalStart?.state?.state
          ? `final=${lifecycle.finalStart.state.state}`
          : "",
        lifecycle?.terminalAfterStart?.marker ? "terminal_start=1" : "",
        lifecycle?.terminalAfterRestart?.marker ? "terminal_restart=1" : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (result.scenario === RECONNECT_STABLE_URL_SCENARIO) {
    const reconnect = result.reconnect;
    console.log(
      [
        `${prefix} reconnect-stable-url`,
        `final_url=${reconnect?.afterUrl ?? result.currentUrl ?? "<unknown>"}`,
        reconnect?.beforeState?.state
          ? `before=${reconnect.beforeState.state}`
          : "",
        reconnect?.afterState?.state
          ? `after=${reconnect.afterState.state}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (result.scenario === SIGN_UP_HOME_BAY_SCENARIO) {
    const signUp = result.signUp;
    const signIn = result.signIn;
    console.log(
      [
        `${prefix} sign-up-home-bay`,
        `signup_url=${signUp?.finalUrl ?? "<unknown>"}`,
        `signin_url=${signIn?.finalUrl ?? "<unknown>"}`,
        signUp?.homeBay?.home_bay_id
          ? `home_bay=${signUp.homeBay.home_bay_id}`
          : "",
        signUp?.accountId ? `account=${signUp.accountId}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else {
    console.log(`${prefix} ${result.scenario}`);
  }

  if (result.status === "fail") {
    console.log(`  error: ${result.error}`);
  }

  const diagnostics = result.diagnostics;
  const warningCount = diagnostics?.console?.length ?? 0;
  const pageErrorCount = diagnostics?.pageErrors?.length ?? 0;
  const failedRequestCount = diagnostics?.failedRequests?.length ?? 0;
  const authStatuses = (diagnostics?.authResponses ?? [])
    .map((response) => response.status)
    .join(",");
  console.log(
    `  observed console=${warningCount} page_errors=${pageErrorCount} failed_requests=${failedRequestCount} auth_statuses=${authStatuses || "none"}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywrightCore();

  if (!options.json) {
    console.log(
      `multibay browser QA base=${options.baseUrl} project=${options.projectId} scenarios=${options.scenarios.join(",")}`,
    );
  }

  const browser = await chromium.launch({
    executablePath: options.chromiumPath,
    headless: !options.headed,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const results = [];
  try {
    for (const scenario of options.scenarios) {
      const result = await runScenario(browser, scenario, options);
      results.push(result);
      if (!options.json) {
        printTextResult(result);
      }
      if (result.status === "fail" && options.failFast) {
        break;
      }
    }
  } finally {
    await bestEffortTimeout(
      "browser.close",
      browser.close().catch(() => {}),
      10_000,
    );
  }

  const summary = {
    ok: results.every((result) => result.status === "pass"),
    baseUrl: options.baseUrl,
    projectId: options.projectId,
    scenarios: options.scenarios,
    results,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  }

  if (!summary.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
