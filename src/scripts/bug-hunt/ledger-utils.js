#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONTEXT_FILE = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "current-context.json",
);
const DEFAULT_LEDGER_ROOT = path.join(ROOT, ".agents", "bug-hunt", "ledger");
const ALLOWED_RESULTS = new Set([
  "bug_fixed",
  "bug_confirmed_no_fix",
  "stale_report",
  "already_fixed",
  "blocked_by_environment",
  "intermittent_unconfirmed",
]);

function sanitizeSegment(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function ensureArray(values) {
  return values.map((value) => `${value ?? ""}`.trim()).filter(Boolean);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to read ${label}: ${detail}`);
  }
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  return readJson(file, file);
}

function normalizeConfidence(value) {
  if (value === "" || value === undefined || value === null) return undefined;
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be a number between 0 and 1");
  }
  return confidence;
}

function coerceIteration(value) {
  if (value === "" || value === undefined || value === null) return undefined;
  const iteration = Number(value);
  if (!Number.isInteger(iteration) || iteration <= 0) {
    throw new Error("iteration must be a positive integer");
  }
  return iteration;
}

function listLedgerEntryFiles(ledgerRoot = DEFAULT_LEDGER_ROOT) {
  if (!fs.existsSync(ledgerRoot)) return [];
  const files = [];
  const stack = [ledgerRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function listLedgerEntries(ledgerRoot = DEFAULT_LEDGER_ROOT) {
  const entries = [];
  for (const file of listLedgerEntryFiles(ledgerRoot)) {
    try {
      const entry = readJson(file, `ledger entry ${file}`);
      entries.push({ ...entry, _file: file });
    } catch (err) {
      entries.push({
        _file: file,
        _parse_error: err instanceof Error ? err.message : `${err}`,
      });
    }
  }
  return entries.sort((left, right) => {
    const a = Number(left.iteration) || 0;
    const b = Number(right.iteration) || 0;
    if (a !== b) return b - a;
    const ta = `${left.timestamp ?? ""}`;
    const tb = `${right.timestamp ?? ""}`;
    return tb.localeCompare(ta);
  });
}

function stripInternalFields(entry) {
  const normalized = { ...entry };
  delete normalized._file;
  delete normalized._parse_error;
  return normalized;
}

function nextIteration(ledgerRoot = DEFAULT_LEDGER_ROOT) {
  let max = 0;
  for (const entry of listLedgerEntries(ledgerRoot)) {
    if (entry && !entry._parse_error) {
      max = Math.max(max, Number(entry.iteration) || 0);
    }
  }
  return max + 1;
}

function buildEntryId(timestamp, iteration, taskId) {
  const stamp = `${timestamp}`.replace(/[:.]/g, "-");
  const parts = [stamp, `i${String(iteration).padStart(4, "0")}`];
  const task = sanitizeSegment(taskId);
  if (task) parts.push(task);
  return parts.join("-");
}

function buildLedgerPaths(ledgerRoot, entry) {
  const dayDir = path.join(ledgerRoot, entry.date);
  const base = [
    String(entry.iteration).padStart(4, "0"),
    sanitizeSegment(entry.result),
    sanitizeSegment(entry.area),
    sanitizeSegment(entry.task_id),
  ]
    .filter(Boolean)
    .join("-");
  return {
    dir: dayDir,
    json: path.join(dayDir, `${base}.json`),
    markdown: path.join(dayDir, `${base}.md`),
  };
}

function buildEntry(options, context, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const date = timestamp.slice(0, 10);
  const taskId = `${options.taskId ?? ""}`.trim();
  const area = `${options.area ?? ""}`.trim();
  const result = `${options.result ?? ""}`.trim();
  if (!taskId) {
    throw new Error("task_id is required");
  }
  if (!area) {
    throw new Error("area is required");
  }
  if (!ALLOWED_RESULTS.has(result)) {
    throw new Error(
      `result must be one of: ${Array.from(ALLOWED_RESULTS).join(", ")}`,
    );
  }
  const iteration =
    coerceIteration(options.iteration) ?? nextIteration(options.ledgerRoot);
  const entry = {
    id: buildEntryId(timestamp, iteration, taskId),
    iteration,
    timestamp,
    date,
    task_id: taskId,
    title: `${options.title ?? ""}`.trim(),
    area,
    result,
    evidence: ensureArray(options.evidence ?? []),
    artifacts: ensureArray(options.artifacts ?? []),
    validation: ensureArray(options.validation ?? []),
    commit_sha: `${options.commitSha ?? ""}`.trim(),
    confidence: normalizeConfidence(options.confidence),
    context: summarizeContext(context),
  };
  return entry;
}

function summarizeContext(context) {
  if (!context || typeof context !== "object") return undefined;
  const summary = {
    mode: `${context.mode ?? ""}`.trim(),
    browser_mode: `${context.browser_mode ?? ""}`.trim(),
    browser_id: `${context.browser_id ?? ""}`.trim(),
    project_id: `${context.project_id ?? ""}`.trim(),
    api_url: `${context.api_url ?? ""}`.trim(),
    session_url: `${context.session_url ?? ""}`.trim(),
  };
  if (Object.values(summary).every((value) => !value)) return undefined;
  return summary;
}

function formatTaskNote(entry) {
  const lines = [
    `${entry.date} bug-hunt: ${entry.result}`,
    `area: ${entry.area}`,
  ];
  if (entry.evidence.length > 0) {
    lines.push(`evidence: ${entry.evidence.join(" | ")}`);
  }
  if (entry.validation.length > 0) {
    lines.push(`validation: ${entry.validation.join(" | ")}`);
  }
  if (entry.commit_sha) {
    lines.push(`commit: ${entry.commit_sha}`);
  }
  if (entry.confidence !== undefined) {
    lines.push(`confidence: ${entry.confidence}`);
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

function formatMarkdownSummary(entry) {
  const lines = [
    `# Bug Hunt Iteration ${entry.iteration}`,
    "",
    `- Task: \`${entry.task_id}\`${entry.title ? ` ${entry.title}` : ""}`,
    `- Area: \`${entry.area}\``,
    `- Result: \`${entry.result}\``,
    `- Timestamp: \`${entry.timestamp}\``,
  ];
  if (entry.commit_sha) {
    lines.push(`- Commit: \`${entry.commit_sha}\``);
  }
  if (entry.confidence !== undefined) {
    lines.push(`- Confidence: \`${entry.confidence}\``);
  }
  if (entry.context) {
    lines.push(
      `- Context: \`${entry.context.mode || "unknown"}\` / \`${entry.context.browser_mode || "unknown"}\` / \`${entry.context.project_id || "unknown-project"}\``,
    );
  }
  if (entry.evidence.length > 0) {
    lines.push("", "## Evidence", "");
    for (const item of entry.evidence) lines.push(`- ${item}`);
  }
  if (entry.validation.length > 0) {
    lines.push("", "## Validation", "");
    for (const item of entry.validation) lines.push(`- ${item}`);
  }
  if (entry.artifacts.length > 0) {
    lines.push("", "## Artifacts", "");
    for (const item of entry.artifacts) lines.push(`- ${item}`);
  }
  lines.push("", "## Task Note", "", formatTaskNote(entry), "");
  return lines.join("\n");
}

function writeLedgerEntry(ledgerRoot, entry) {
  const normalized = stripInternalFields(entry);
  const paths = buildLedgerPaths(ledgerRoot, normalized);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.writeFileSync(paths.markdown, `${formatMarkdownSummary(normalized)}\n`);
  return paths;
}

function findLedgerEntry(ledgerRoot, options = {}) {
  const taskId = `${options.taskId ?? ""}`.trim();
  const requestedIteration = coerceIteration(options.iteration);
  return (
    listLedgerEntries(ledgerRoot).find((entry) => {
      if (entry._parse_error) return false;
      if (requestedIteration !== undefined) {
        return Number(entry.iteration) === requestedIteration;
      }
      return !!taskId && entry.task_id === taskId;
    }) || undefined
  );
}

function updateLedgerCommit(ledgerRoot, options = {}) {
  const commitSha = `${options.commitSha ?? ""}`.trim();
  if (!commitSha) {
    throw new Error("commitSha is required");
  }
  const entry = findLedgerEntry(ledgerRoot, options);
  if (!entry) {
    throw new Error("matching ledger entry not found");
  }
  const updated = {
    ...stripInternalFields(entry),
    commit_sha: commitSha,
  };
  const paths = writeLedgerEntry(ledgerRoot, updated);
  return {
    entry: updated,
    paths,
  };
}

module.exports = {
  ALLOWED_RESULTS,
  DEFAULT_CONTEXT_FILE,
  DEFAULT_LEDGER_ROOT,
  buildEntry,
  buildLedgerPaths,
  coerceIteration,
  ensureArray,
  findLedgerEntry,
  formatMarkdownSummary,
  formatTaskNote,
  listLedgerEntries,
  nextIteration,
  normalizeConfidence,
  readJson,
  readJsonIfExists,
  sanitizeSegment,
  stripInternalFields,
  summarizeContext,
  updateLedgerCommit,
  writeLedgerEntry,
};
