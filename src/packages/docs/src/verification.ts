/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import {
  docsPath,
  getDocsAction,
  getDocsChapter,
  getDocsEntry,
  listDocsChapters,
  listDocsActions,
  listDocsEntries,
  type DocsActionId,
} from "./index";
import { LEGACY_DOC_LINK_BASELINE } from "./legacy-doc-links-baseline";

export type DocsVerificationSeverity = "error" | "warning";

export type DocsVerificationIssue = {
  actionId?: string;
  code: string;
  entryId?: string;
  message: string;
  severity: DocsVerificationSeverity;
};

export type DocsLiveVerificationScenario = {
  assertion?: DocsLiveUiAssertion;
  actionId: DocsActionId;
  command: string[];
  description: string;
  entryId: string;
  mutatesProject?: boolean;
};

export type DocsLiveUiAssertion = {
  cleanupCode?: string;
  code: string;
  description: string;
};

export type DocsVerificationReport = {
  actionCount: number;
  entryCount: number;
  issues: DocsVerificationIssue[];
  legacyDocLinks: DocsLegacyDocLink[];
  liveScenarios: DocsLiveVerificationScenario[];
  ok: boolean;
};

export type DocsLegacyDocLink = {
  baseline: boolean;
  file: string;
  line: number;
  url: string;
};

export type DocsGapEntry = {
  actionIds?: DocsActionId[];
  category: string;
  id: string;
  lastReviewed?: string;
  reviewAgeDays?: number;
  slug: string;
  title: string;
};

export type DocsGapReport = {
  categoriesWithoutChapter: string[];
  entryCount: number;
  legacyDocLinks: DocsLegacyDocLink[];
  ok: boolean;
  pagesWithStaleReview: DocsGapEntry[];
  pagesWithoutActions: DocsGapEntry[];
  pagesWithoutLiveVerification: DocsGapEntry[];
  staleReviewDays: number;
};

export type DocsLiveVerificationResult = {
  assertion?: DocsLiveAssertionResult;
  actionId: DocsActionId;
  command: string[];
  ok: boolean;
  output?: unknown;
  stderr?: string;
  stdout?: string;
  error?: string;
};

export type DocsLiveAssertionResult = {
  command: string[];
  ok: boolean;
  output?: unknown;
  stderr?: string;
  stdout?: string;
  error?: string;
  cleanup?: {
    command: string[];
    ok: boolean;
    output?: unknown;
    stderr?: string;
    stdout?: string;
    error?: string;
  };
};

export type DocsLiveVerificationOptions = {
  actionIds?: DocsActionId[];
  browserId?: string;
  cocalcArgs?: string[];
  cocalcCommand?: string;
  projectId: string;
  timeout?: string;
};

export type DocsLiveVerificationReport = {
  ok: boolean;
  results: DocsLiveVerificationResult[];
};

const DOCS_LINK_RE = /\/docs\/([A-Za-z0-9._/-]+)/g;
const LEGACY_DOCS_RE = /https:\/\/doc\.cocalc\.com\/[^\s"'<>)]*/g;
const DEFAULT_STALE_REVIEW_DAYS = 90;
const LEGACY_LINK_SCAN_ROOTS = [":(top)src/packages/frontend"];

const UI_ASSERTION_TIMEOUT_MS = 15_000;

function issue({
  actionId,
  code,
  entryId,
  message,
  severity = "error",
}: {
  actionId?: string;
  code: string;
  entryId?: string;
  message: string;
  severity?: DocsVerificationSeverity;
}): DocsVerificationIssue {
  return { actionId, code, entryId, message, severity };
}

function hasDuplicate(value: string, seen: Set<string>): boolean {
  if (seen.has(value)) return true;
  seen.add(value);
  return false;
}

function executableActionIds(): Set<string> {
  return new Set(
    listDocsActions()
      .filter((action) => action.executable === true)
      .map((action) => action.id),
  );
}

function legacyLinkKey(link: Pick<DocsLegacyDocLink, "file" | "url">): string {
  return `${link.file}\t${link.url}`;
}

function runSyncCommand(
  command: string,
  args: string[],
): { status: number | null; stdout: string } {
  const requireFunction = eval("require") as (name: string) => unknown;
  const childProcess = requireFunction("node:child_process") as {
    spawnSync: (
      command: string,
      args: string[],
      options: { encoding: "utf8" },
    ) => { status: number | null; stdout: string };
  };
  return childProcess.spawnSync(command, args, { encoding: "utf8" });
}

export function scanLegacyDocLinks(): DocsLegacyDocLink[] {
  const result = runSyncCommand("git", [
    "grep",
    "--full-name",
    "-n",
    "-I",
    "-E",
    "https://doc\\.cocalc\\.com/[^[:space:]\"'<>)]*",
    "--",
    ...LEGACY_LINK_SCAN_ROOTS,
  ]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const links: DocsLegacyDocLink[] = [];
  for (const row of result.stdout.trim().split("\n")) {
    const match = row.match(/^([^:]+):(\d+):(.*)$/);
    if (!match) continue;
    const [, file, lineText, text] = match;
    for (const urlMatch of text.matchAll(LEGACY_DOCS_RE)) {
      const link = {
        baseline: false,
        file,
        line: Number.parseInt(lineText, 10),
        url: urlMatch[0],
      };
      links.push({
        ...link,
        baseline: LEGACY_DOC_LINK_BASELINE.has(legacyLinkKey(link)),
      });
    }
  }
  return links.sort((a, b) => legacyLinkKey(a).localeCompare(legacyLinkKey(b)));
}

function entryGap(entry: {
  actions?: { id: DocsActionId }[];
  category: string;
  id: string;
  lastReviewed: string;
  slug: string;
  title: string;
}): DocsGapEntry {
  const actionIds = entry.actions?.map((action) => action.id);
  return {
    ...(actionIds?.length ? { actionIds } : {}),
    category: entry.category,
    id: entry.id,
    lastReviewed: entry.lastReviewed,
    slug: entry.slug,
    title: entry.title,
  };
}

function reviewAgeDays(lastReviewed: string, now: Date): number | undefined {
  const reviewed = Date.parse(`${lastReviewed}T00:00:00Z`);
  if (!Number.isFinite(reviewed)) return undefined;
  return Math.floor((now.getTime() - reviewed) / 86_400_000);
}

function liveUiAssertionForAction(
  actionId: DocsActionId,
): DocsLiveUiAssertion | undefined {
  if (actionId.startsWith("account.") || actionId.startsWith("billing.")) {
    const settingsPaths: Partial<Record<DocsActionId, string>> = {
      "account.profile.open": "/settings/profile",
      "account.ssh-keys.open": "/settings/keys",
      "billing.payment-methods.open": "/settings/payment-methods",
      "billing.statements.open": "/settings/statements",
      "billing.subscriptions.open": "/settings/subscriptions",
    };
    const expectedPath = settingsPaths[actionId];
    if (expectedPath) {
      return {
        description: `Account settings route ${expectedPath} is visible.`,
        code: `const url = api.waitForUrl({ includes: ${JSON.stringify(expectedPath)}, timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true, url };`,
      };
    }
  }
  if (actionId.startsWith("admin.")) {
    const adminPaths: Partial<Record<DocsActionId, string>> = {
      "admin.news.open": "/admin/news",
      "admin.news.create-system": "/admin/news/new",
      "admin.bay-ops.open": "/admin/bay-ops",
      "admin.managed-egress.open": "/admin/managed-egress",
      "admin.membership-tiers.open": "/admin/membership-tiers",
      "admin.project-backup-shards.open": "/admin/project-backup-shards",
      "admin.registration-tokens.open": "/admin/registration-tokens",
      "admin.rootfs.open": "/admin/rootfs",
      "admin.site-settings.open": "/admin/site-settings",
      "admin.software-licenses.open": "/admin/software-licenses",
      "admin.sso.open": "/admin/sso",
      "admin.users.open": "/admin/user-search",
    };
    const expectedPath = adminPaths[actionId];
    if (expectedPath) {
      return {
        description: `Admin route ${expectedPath} is visible.`,
        code: `const url = api.waitForUrl({ includes: ${JSON.stringify(expectedPath)}, timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true, url };`,
      };
    }
  }
  if (actionId.startsWith("hosts.")) {
    return {
      description: "Project Hosts route is visible.",
      code: `const url = api.waitForUrl({ includes: "/hosts", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true, url };`,
    };
  }
  if (actionId === "settings.environment.secrets") {
    return {
      description: "Project Secrets modal is visible.",
      code: `const modal = api.waitForText({ selector: ".ant-modal[role=dialog]", includes: "Project Secrets", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: modal.ok === true, modal };`,
      cleanupCode: `api.press("Escape");
return api.waitForSelector(".ant-modal[role=dialog]", { state: "hidden", timeout_ms: 3000 });`,
    };
  }
  if (actionId === "project.terminal.open") {
    return {
      description: "Terminal file tab and xterm UI are visible.",
      code: `const url = api.waitForUrl({ regex: "/\\/files\\/.+\\.term(?:[?#]|$)/", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
const terminal = api.waitForText({ selector: ".terminal.xterm", includes: "$", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true && terminal.ok === true, url, terminal };`,
    };
  }
  if (actionId === "project.jupyter.create") {
    return {
      description: "Notebook file tab and Jupyter UI are visible.",
      code: `const url = api.waitForUrl({ regex: "/\\/files\\/.+\\.ipynb(?:[?#]|$)/", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
const notebook = api.waitForText({ includes: "Jupyter", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true && notebook.ok === true, url, notebook };`,
    };
  }
  if (actionId === "settings.runtime.rootfs") {
    return {
      description: "Runtime Image modal is visible.",
      code: `const modal = api.waitForText({ selector: ".ant-modal[role=dialog]", includes: "Runtime Image", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: modal.ok === true, modal };`,
      cleanupCode: `api.press("Escape");
return api.waitForSelector(".ant-modal[role=dialog]", { state: "hidden", timeout_ms: 3000 });`,
    };
  }
  if (actionId === "settings.people.collaborators") {
    return {
      description: "Project People settings are visible.",
      code: `const people = api.waitForText({ includes: "Collaborators", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: people.ok === true, people };`,
    };
  }
  if (actionId === "file.timetravel.open") {
    return {
      description: "TimeTravel opens for a project file.",
      code: `const url = api.waitForUrl({ includes: ".time-travel", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
const timetravel = api.waitForText({ includes: "TimeTravel", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true && timetravel.ok === true, url, timetravel };`,
    };
  }
  if (actionId === "project.codex.open") {
    return {
      description: "Project Agents UI is visible.",
      code: `const url = api.waitForUrl({ includes: "/agents", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
const agents = api.waitForText({ includes: "Agents", timeout_ms: ${UI_ASSERTION_TIMEOUT_MS} });
return { ok: url.ok === true && agents.ok === true, url, agents };`,
    };
  }
}

export function listDocsLiveVerificationScenarios({
  cocalcArgs = [],
  cocalcCommand = "cocalc",
  projectId = "$COCALC_PROJECT_ID",
  timeout = "60s",
}: Partial<DocsLiveVerificationOptions> = {}): DocsLiveVerificationScenario[] {
  return listDocsActions({ includeAdmin: true, includeSignedIn: true })
    .filter((action) => action.executable === true)
    .map((action) => {
      const command = [
        cocalcCommand,
        ...cocalcArgs,
        "browser",
        "action",
        "docs",
        action.id,
        "--project-id",
        projectId,
        "--timeout",
        timeout,
      ];
      return {
        assertion: liveUiAssertionForAction(action.id),
        actionId: action.id,
        command,
        description: action.description,
        entryId: action.entryId,
        mutatesProject:
          action.id === "project.terminal.open" ||
          action.id === "project.jupyter.create" ||
          action.id === "file.timetravel.open",
      };
    });
}

export function verifyDocsStatic(): DocsVerificationReport {
  const docsAccess = { includeAdmin: true, includeSignedIn: true };
  const entries = listDocsEntries(docsAccess);
  const actions = listDocsActions(docsAccess);
  const chapters = listDocsChapters(docsAccess);
  const issues: DocsVerificationIssue[] = [];
  const entryIds = new Set<string>();
  const slugs = new Set<string>();
  const actionIds = new Set<string>();
  const categories = new Set(entries.map((entry) => entry.category));

  for (const entry of entries) {
    if (!entry.id.trim()) {
      issues.push(
        issue({
          code: "entry-id-empty",
          message: "Docs entry id is empty.",
        }),
      );
    } else if (hasDuplicate(entry.id, entryIds)) {
      issues.push(
        issue({
          code: "entry-id-duplicate",
          entryId: entry.id,
          message: `Duplicate docs entry id '${entry.id}'.`,
        }),
      );
    }
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(entry.id)) {
      issues.push(
        issue({
          code: "entry-id-format",
          entryId: entry.id,
          message: `Docs entry id '${entry.id}' should be dotted lowercase words.`,
          severity: "warning",
        }),
      );
    }
    if (!entry.slug.trim()) {
      issues.push(
        issue({
          code: "entry-slug-empty",
          entryId: entry.id,
          message: "Docs entry slug is empty.",
        }),
      );
    } else if (hasDuplicate(entry.slug, slugs)) {
      issues.push(
        issue({
          code: "entry-slug-duplicate",
          entryId: entry.id,
          message: `Duplicate docs entry slug '${entry.slug}'.`,
        }),
      );
    }
    if (entry.slug.startsWith("/") || entry.slug.includes("..")) {
      issues.push(
        issue({
          code: "entry-slug-format",
          entryId: entry.id,
          message: `Docs entry slug '${entry.slug}' must be relative and normalized.`,
        }),
      );
    }
    if (getDocsEntry(entry.id, docsAccess)?.id !== entry.id) {
      issues.push(
        issue({
          code: "entry-id-lookup",
          entryId: entry.id,
          message: `Docs entry '${entry.id}' cannot be found by id.`,
        }),
      );
    }
    if (getDocsEntry(entry.slug, docsAccess)?.id !== entry.id) {
      issues.push(
        issue({
          code: "entry-slug-lookup",
          entryId: entry.id,
          message: `Docs entry '${entry.id}' cannot be found by slug '${entry.slug}'.`,
        }),
      );
    }
    if (docsPath(entry.slug) !== `/docs/${entry.slug}`) {
      issues.push(
        issue({
          code: "entry-docs-path",
          entryId: entry.id,
          message: `Docs path helper returned an unexpected path for '${entry.slug}'.`,
        }),
      );
    }
    if (
      !entry.title.trim() ||
      !entry.summary.trim() ||
      !entry.category.trim()
    ) {
      issues.push(
        issue({
          code: "entry-metadata-empty",
          entryId: entry.id,
          message: "Docs entry title, summary, and category are required.",
        }),
      );
    }
    if (!entry.body.includes("## ")) {
      issues.push(
        issue({
          code: "entry-body-headings",
          entryId: entry.id,
          message: "Docs entry body should include section headings.",
          severity: "warning",
        }),
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.lastReviewed)) {
      issues.push(
        issue({
          code: "entry-last-reviewed",
          entryId: entry.id,
          message: "Docs entry lastReviewed must be YYYY-MM-DD.",
        }),
      );
    }
    if (entry.body.match(LEGACY_DOCS_RE)) {
      issues.push(
        issue({
          code: "entry-legacy-doc-link",
          entryId: entry.id,
          message: "Docs entry links to legacy doc.cocalc.com documentation.",
        }),
      );
    }
    for (const match of entry.body.matchAll(DOCS_LINK_RE)) {
      const slug = match[1]?.replace(/[),.;:]+$/, "");
      if (slug && !getDocsEntry(slug, docsAccess)) {
        issues.push(
          issue({
            code: "entry-internal-link",
            entryId: entry.id,
            message: `Internal docs link '/docs/${slug}' does not resolve.`,
          }),
        );
      }
    }
    for (const action of entry.actions ?? []) {
      if (getDocsAction(action.id, docsAccess)?.id !== action.id) {
        issues.push(
          issue({
            actionId: action.id,
            code: "action-lookup",
            entryId: entry.id,
            message: `Docs action '${action.id}' cannot be resolved.`,
          }),
        );
      }
      if (hasDuplicate(action.id, actionIds)) {
        issues.push(
          issue({
            actionId: action.id,
            code: "action-id-duplicate",
            entryId: entry.id,
            message: `Duplicate docs action id '${action.id}'.`,
          }),
        );
      }
      if (!action.label.trim() || !action.description.trim()) {
        issues.push(
          issue({
            actionId: action.id,
            code: "action-metadata-empty",
            entryId: entry.id,
            message: "Docs action label and description are required.",
          }),
        );
      }
    }
  }

  for (const category of categories) {
    if (getDocsChapter(category, docsAccess) == null) {
      issues.push(
        issue({
          code: "chapter-missing",
          message: `Docs category '${category}' has no chapter metadata.`,
        }),
      );
    }
  }

  for (const chapter of chapters) {
    const startEntry = getDocsEntry(chapter.startEntryId, docsAccess);
    if (startEntry == null) {
      issues.push(
        issue({
          code: "chapter-start-entry",
          entryId: chapter.startEntryId,
          message: `Docs chapter '${chapter.category}' start entry '${chapter.startEntryId}' does not resolve.`,
        }),
      );
    } else if (startEntry.category !== chapter.category) {
      issues.push(
        issue({
          code: "chapter-start-category",
          entryId: startEntry.id,
          message: `Docs chapter '${chapter.category}' starts with entry '${startEntry.id}' in category '${startEntry.category}'.`,
        }),
      );
    }
    if (!chapter.summary.trim() || chapter.workflows.length === 0) {
      issues.push(
        issue({
          code: "chapter-metadata-empty",
          message: `Docs chapter '${chapter.category}' needs a summary and workflows.`,
        }),
      );
    }
  }

  const scenarioActionIds = new Set(
    listDocsLiveVerificationScenarios().map((scenario) => scenario.actionId),
  );
  for (const actionId of executableActionIds()) {
    if (!scenarioActionIds.has(actionId as DocsActionId)) {
      issues.push(
        issue({
          actionId,
          code: "action-missing-live-scenario",
          message: `Executable docs action '${actionId}' has no live verification scenario.`,
        }),
      );
    }
  }

  const legacyDocLinks = scanLegacyDocLinks();
  for (const link of legacyDocLinks) {
    if (!link.baseline) {
      issues.push(
        issue({
          code: "legacy-doc-link-new",
          message: `New legacy doc.cocalc.com link in ${link.file}:${link.line}: ${link.url}`,
        }),
      );
    }
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  return {
    actionCount: actions.length,
    entryCount: entries.length,
    issues,
    legacyDocLinks,
    liveScenarios: listDocsLiveVerificationScenarios(),
    ok: errors.length === 0,
  };
}

export function buildDocsGapReport({
  now = new Date(),
  staleReviewDays = DEFAULT_STALE_REVIEW_DAYS,
}: {
  now?: Date;
  staleReviewDays?: number;
} = {}): DocsGapReport {
  const docsAccess = { includeAdmin: true, includeSignedIn: true };
  const entries = listDocsEntries(docsAccess);
  const categories = [
    ...new Set(entries.map((entry) => entry.category)),
  ].sort();
  const liveAssertionsByAction = new Map(
    listDocsLiveVerificationScenarios().map((scenario) => [
      scenario.actionId,
      scenario.assertion,
    ]),
  );
  const pagesWithoutActions: DocsGapEntry[] = [];
  const pagesWithoutLiveVerification: DocsGapEntry[] = [];
  const pagesWithStaleReview: DocsGapEntry[] = [];

  for (const entry of entries) {
    const actions = entry.actions ?? [];
    if (actions.length === 0) {
      pagesWithoutActions.push(entryGap(entry));
      pagesWithoutLiveVerification.push(entryGap(entry));
    } else {
      const hasAssertedLiveAction = actions.some(
        (action) =>
          action.executable === true &&
          liveAssertionsByAction.get(action.id) != null,
      );
      if (!hasAssertedLiveAction) {
        pagesWithoutLiveVerification.push(entryGap(entry));
      }
    }
    const ageDays = reviewAgeDays(entry.lastReviewed, now);
    if (ageDays != null && ageDays > staleReviewDays) {
      pagesWithStaleReview.push({
        ...entryGap(entry),
        reviewAgeDays: ageDays,
      });
    }
  }

  return {
    categoriesWithoutChapter: categories.filter(
      (category) => getDocsChapter(category, docsAccess) == null,
    ),
    entryCount: entries.length,
    legacyDocLinks: scanLegacyDocLinks(),
    ok:
      pagesWithoutActions.length === 0 &&
      pagesWithoutLiveVerification.length === 0 &&
      pagesWithStaleReview.length === 0,
    pagesWithStaleReview,
    pagesWithoutActions,
    pagesWithoutLiveVerification,
    staleReviewDays,
  };
}

function runCommand({
  args,
  command,
}: {
  args: string[];
  command: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function liveAssertionScriptSucceeded(output: unknown): boolean {
  const data =
    output && typeof output === "object" && "data" in output
      ? (output as { data?: any }).data
      : undefined;
  if (!data || typeof data !== "object" || data.ok === false) {
    return false;
  }
  const result = data?.result ?? data;
  const scriptResult = result?.script_result ?? result;
  return (
    scriptResult != null &&
    typeof scriptResult === "object" &&
    scriptResult.ok === true
  );
}

async function runLiveUiAssertion({
  assertion,
  browserId,
  cocalcArgs,
  cocalcCommand,
  projectId,
  timeout,
}: {
  assertion: DocsLiveUiAssertion;
  browserId?: string;
  cocalcArgs: string[];
  cocalcCommand: string;
  projectId: string;
  timeout: string;
}): Promise<DocsLiveAssertionResult> {
  const command = [
    cocalcCommand,
    ...cocalcArgs,
    "browser",
    "exec",
    "--project-id",
    projectId,
    "--timeout",
    timeout,
  ];
  if (browserId) {
    command.push("--browser", browserId);
  }
  command.push(assertion.code);
  const [bin, ...args] = command;
  let assertionResult: DocsLiveAssertionResult;
  try {
    const { code, stdout, stderr } = await runCommand({
      args,
      command: bin,
    });
    const output = parseJsonOutput(stdout);
    const ok = code === 0 && liveAssertionScriptSucceeded(output);
    assertionResult = {
      command,
      ok,
      output,
      stderr,
      stdout,
      ...(ok
        ? {}
        : {
            error:
              code === 0
                ? "live UI assertion did not report ok=true"
                : `assertion command exited with code ${code ?? "unknown"}`,
          }),
    };
  } catch (err) {
    assertionResult = {
      command,
      error: err instanceof Error ? err.message : `${err}`,
      ok: false,
    };
  }

  if (assertion.cleanupCode) {
    const cleanupCommand = [
      cocalcCommand,
      ...cocalcArgs,
      "browser",
      "exec",
      "--project-id",
      projectId,
      "--timeout",
      "10s",
    ];
    if (browserId) {
      cleanupCommand.push("--browser", browserId);
    }
    cleanupCommand.push(assertion.cleanupCode);
    const [cleanupBin, ...cleanupArgs] = cleanupCommand;
    try {
      const { code, stdout, stderr } = await runCommand({
        args: cleanupArgs,
        command: cleanupBin,
      });
      const output = parseJsonOutput(stdout);
      assertionResult.cleanup = {
        command: cleanupCommand,
        ok: code === 0 && liveAssertionScriptSucceeded(output),
        output,
        stderr,
        stdout,
      };
    } catch (err) {
      assertionResult.cleanup = {
        command: cleanupCommand,
        error: err instanceof Error ? err.message : `${err}`,
        ok: false,
      };
    }
  }
  return assertionResult;
}

export async function verifyDocsLive({
  actionIds,
  browserId,
  cocalcArgs = ["--json"],
  cocalcCommand = "cocalc",
  projectId,
  timeout = "60s",
}: DocsLiveVerificationOptions): Promise<DocsLiveVerificationReport> {
  const selected = new Set(actionIds ?? []);
  const scenarios = listDocsLiveVerificationScenarios({
    cocalcArgs,
    cocalcCommand,
    projectId,
    timeout,
  }).filter(
    (scenario) => selected.size === 0 || selected.has(scenario.actionId),
  );
  const results: DocsLiveVerificationResult[] = [];
  for (const scenario of scenarios) {
    const command = [...scenario.command];
    if (browserId) {
      command.push("--browser", browserId);
    }
    const [bin, ...args] = command;
    try {
      const { code, stdout, stderr } = await runCommand({
        args,
        command: bin,
      });
      const output = parseJsonOutput(stdout);
      const data =
        output && typeof output === "object" && "data" in output
          ? (output as { data?: any }).data
          : undefined;
      const result = data?.result ?? data;
      const ok =
        code === 0 &&
        data?.ok !== false &&
        result?.opened === true &&
        result?.action_id === scenario.actionId;
      const assertion =
        ok && scenario.assertion
          ? await runLiveUiAssertion({
              assertion: scenario.assertion,
              browserId,
              cocalcArgs,
              cocalcCommand,
              projectId,
              timeout,
            })
          : undefined;
      results.push({
        assertion,
        actionId: scenario.actionId,
        command,
        ok: ok && (assertion?.ok ?? true),
        output,
        stderr,
        stdout,
        ...(ok && (assertion?.ok ?? true)
          ? {}
          : {
              error:
                ok && assertion?.error
                  ? assertion.error
                  : code === 0
                    ? "docs action did not report the expected opened result"
                    : `command exited with code ${code ?? "unknown"}`,
            }),
      });
    } catch (err) {
      results.push({
        actionId: scenario.actionId,
        command,
        error: err instanceof Error ? err.message : `${err}`,
        ok: false,
      });
    }
  }
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

export function formatDocsVerificationReport(
  report: DocsVerificationReport,
): string {
  const lines = [
    `Docs verification: ${report.ok ? "ok" : "failed"}`,
    `Entries: ${report.entryCount}`,
    `Actions: ${report.actionCount}`,
    `Live scenarios: ${report.liveScenarios.length}`,
    `Legacy doc.cocalc.com links: ${report.legacyDocLinks.length}`,
  ];
  for (const item of report.issues) {
    const target = [item.entryId, item.actionId].filter(Boolean).join(" ");
    lines.push(
      `${item.severity.toUpperCase()} ${item.code}${target ? ` ${target}` : ""}: ${item.message}`,
    );
  }
  return lines.join("\n");
}

function formatGapEntries(entries: DocsGapEntry[]): string[] {
  return entries.map((entry) => {
    const actions = entry.actionIds?.length
      ? ` actions=${entry.actionIds.join(",")}`
      : "";
    const reviewAge =
      entry.reviewAgeDays == null ? "" : ` reviewed=${entry.reviewAgeDays}d`;
    return `- ${entry.category}: ${entry.title} (${entry.slug})${actions}${reviewAge}`;
  });
}

export function formatDocsGapReport(report: DocsGapReport): string {
  const lines = [
    `Docs gaps: ${report.ok ? "none blocking" : "open"}`,
    `Entries: ${report.entryCount}`,
    `Legacy doc.cocalc.com links: ${report.legacyDocLinks.length}`,
    `Stale review threshold: ${report.staleReviewDays} days`,
    "",
    `Categories without chapter (${report.categoriesWithoutChapter.length})`,
    ...report.categoriesWithoutChapter.map((category) => `- ${category}`),
    "",
    `Pages without actions (${report.pagesWithoutActions.length})`,
    ...formatGapEntries(report.pagesWithoutActions),
    "",
    `Pages without asserted live verification (${report.pagesWithoutLiveVerification.length})`,
    ...formatGapEntries(report.pagesWithoutLiveVerification),
    "",
    `Pages with stale lastReviewed (${report.pagesWithStaleReview.length})`,
    ...formatGapEntries(report.pagesWithStaleReview),
  ];
  return lines.join("\n");
}
