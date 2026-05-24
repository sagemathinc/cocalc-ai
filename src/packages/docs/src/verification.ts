/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import {
  docsPath,
  getDocsAction,
  getDocsEntry,
  listDocsActions,
  listDocsEntries,
  type DocsActionId,
} from "./index";

export type DocsVerificationSeverity = "error" | "warning";

export type DocsVerificationIssue = {
  actionId?: string;
  code: string;
  entryId?: string;
  message: string;
  severity: DocsVerificationSeverity;
};

export type DocsLiveVerificationScenario = {
  actionId: DocsActionId;
  command: string[];
  description: string;
  entryId: string;
  mutatesProject?: boolean;
};

export type DocsVerificationReport = {
  actionCount: number;
  entryCount: number;
  issues: DocsVerificationIssue[];
  liveScenarios: DocsLiveVerificationScenario[];
  ok: boolean;
};

export type DocsLiveVerificationResult = {
  actionId: DocsActionId;
  command: string[];
  ok: boolean;
  output?: unknown;
  stderr?: string;
  stdout?: string;
  error?: string;
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
const LEGACY_DOCS_RE = /https:\/\/doc\.cocalc\.com\//;

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

export function listDocsLiveVerificationScenarios({
  cocalcArgs = [],
  cocalcCommand = "cocalc",
  projectId = "$COCALC_PROJECT_ID",
  timeout = "60s",
}: Partial<DocsLiveVerificationOptions> = {}): DocsLiveVerificationScenario[] {
  return listDocsActions()
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
        actionId: action.id,
        command,
        description: action.description,
        entryId: action.entryId,
        mutatesProject:
          action.id === "project.terminal.open" ||
          action.id === "project.jupyter.create",
      };
    });
}

export function verifyDocsStatic(): DocsVerificationReport {
  const entries = listDocsEntries();
  const actions = listDocsActions();
  const issues: DocsVerificationIssue[] = [];
  const entryIds = new Set<string>();
  const slugs = new Set<string>();
  const actionIds = new Set<string>();

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
    if (getDocsEntry(entry.id)?.id !== entry.id) {
      issues.push(
        issue({
          code: "entry-id-lookup",
          entryId: entry.id,
          message: `Docs entry '${entry.id}' cannot be found by id.`,
        }),
      );
    }
    if (getDocsEntry(entry.slug)?.id !== entry.id) {
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
    if (LEGACY_DOCS_RE.test(entry.body)) {
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
      if (slug && !getDocsEntry(slug)) {
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
      if (getDocsAction(action.id)?.id !== action.id) {
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

  const errors = issues.filter((entry) => entry.severity === "error");
  return {
    actionCount: actions.length,
    entryCount: entries.length,
    issues,
    liveScenarios: listDocsLiveVerificationScenarios(),
    ok: errors.length === 0,
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
      results.push({
        actionId: scenario.actionId,
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
  ];
  for (const item of report.issues) {
    const target = [item.entryId, item.actionId].filter(Boolean).join(" ");
    lines.push(
      `${item.severity.toUpperCase()} ${item.code}${target ? ` ${target}` : ""}: ${item.message}`,
    );
  }
  return lines.join("\n");
}
