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
const KNOWN_SCENARIOS = new Set([...DEFAULT_SCENARIOS, INVITE_REDEEM_SCENARIO]);

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
      "                            Known: sign-in-target, storage-archives, invite-redeem",
      "  --owner-email <address>    Inviter account for invite-redeem; defaults to --email",
      "  --owner-password <pass>    Inviter password for invite-redeem; defaults to --password",
      "  --invitee-email <address>  Invitee account for invite-redeem",
      "  --invitee-password <pass>  Invitee password for invite-redeem",
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
  options.scenarios = normalizeScenarios(options.scenarios);

  if (!options.baseUrl) usageAndExit("--base-url is required");
  if (!options.projectId) usageAndExit("--project is required");
  if (
    options.scenarios.some((scenario) =>
      ["sign-in-target", "storage-archives"].includes(scenario),
    )
  ) {
    if (!options.email) usageAndExit("--email is required");
    if (!options.password) usageAndExit("--password is required");
  }
  if (options.scenarios.includes(INVITE_REDEEM_SCENARIO)) {
    if (!options.ownerEmail) {
      usageAndExit("--owner-email is required for invite-redeem");
    }
    if (!options.ownerPassword) {
      usageAndExit("--owner-password is required for invite-redeem");
    }
    if (!options.inviteeEmail) {
      usageAndExit("--invitee-email is required for invite-redeem");
    }
    if (!options.inviteePassword) {
      usageAndExit("--invitee-password is required for invite-redeem");
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
  await page.goto(`${options.baseUrl}/auth/sign-in?target=%2F`, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await assertNoStaleBuild(page);
  await fillAndSubmitSignIn(page, credentials);
  await page.waitForURL(
    (url) => url.origin === options.baseOrigin && url.pathname === "/",
    { timeout: options.timeoutMs },
  );
  await assertNoStaleBuild(page);
  await waitForRuntime(page, options);
  return { finalUrl: redact(page.url()), target: "/" };
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

      async function withTimeout(label, promise) {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
            }),
          ]);
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

async function runScenario(browser, scenario, options) {
  if (scenario === INVITE_REDEEM_SCENARIO) {
    return await runInviteRedeemScenario(browser, options);
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
    await context.close().catch(() => {});
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
    await browser.close().catch(() => {});
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
