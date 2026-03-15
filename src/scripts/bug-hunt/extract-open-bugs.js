#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TASKS_FILE =
  process.env.COCALC_BUG_HUNT_TASKS ||
  "/home/wstein/cocalc.com/work/wstein.tasks";
const DEFAULT_LIMIT = 25;
const DEFAULT_STALE_DAYS = 14;
const BUG_TAGS = new Set(["bug", "blocker"]);
const SEVERITY_LEVELS = ["low", "medium", "high", "blocker"];
const AREA_TAGS = [
  "chat",
  "codex",
  "jupyter",
  "terminal",
  "files",
  "explorer",
  "tasks",
  "slate",
  "markdown",
  "whiteboard",
  "launchpad",
  "lite",
  "hub",
  "browser",
  "compute",
  "cloud",
  "hosts",
  "git",
];

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: extract-open-bugs.js [--tasks <path>] [--fresh] [--area <csv>] [--environment <lite|hub|either>] [--min-severity <low|medium|high|blocker>] [--group-by-area] [--per-area <n>] [--limit <n>] [--exclude-stale-days <n>] [--json] [--include-non-bugs]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    tasksFile: DEFAULT_TASKS_FILE,
    freshOnly: false,
    json: false,
    limit: DEFAULT_LIMIT,
    includeNonBugs: false,
    excludeStaleDays: DEFAULT_STALE_DAYS,
    areas: [],
    environments: [],
    minSeverity: "",
    groupByArea: false,
    perArea: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tasks") {
      options.tasksFile = argv[++i] || usageAndExit("--tasks requires a path");
    } else if (arg === "--fresh") {
      options.freshOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--include-non-bugs") {
      options.includeNonBugs = true;
    } else if (arg === "--limit") {
      options.limit = Number(argv[++i] || "");
      if (!Number.isFinite(options.limit) || options.limit < 0) {
        usageAndExit("--limit must be a non-negative number");
      }
    } else if (arg === "--exclude-stale-days") {
      options.excludeStaleDays = Number(argv[++i] || "");
      if (
        !Number.isFinite(options.excludeStaleDays) ||
        options.excludeStaleDays < 0
      ) {
        usageAndExit("--exclude-stale-days must be a non-negative number");
      }
    } else if (arg === "--area") {
      options.areas = `${argv[++i] || ""}`
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--environment") {
      options.environments = `${argv[++i] || ""}`
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--min-severity") {
      options.minSeverity =
        `${argv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--min-severity requires a value");
      if (!SEVERITY_LEVELS.includes(options.minSeverity)) {
        usageAndExit("--min-severity must be low, medium, high, or blocker");
      }
    } else if (arg === "--group-by-area") {
      options.groupByArea = true;
    } else if (arg === "--per-area") {
      options.perArea = Number(argv[++i] || "");
      if (!Number.isFinite(options.perArea) || options.perArea < 0) {
        usageAndExit("--per-area must be a non-negative number");
      }
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readTasksFile(tasksFile) {
  const text = fs.readFileSync(tasksFile, "utf8");
  const rows = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      const detail = err instanceof Error ? err.message : `${err}`;
      throw new Error(
        `Failed to parse ${path.basename(tasksFile)} line ${index + 1}: ${detail}`,
      );
    }
  }
  return rows;
}

function extractTags(text) {
  const tags = new Set();
  const matches = `${text ?? ""}`.matchAll(/(^|\s)#([^\s#]+)/g);
  for (const match of matches) {
    const value = match[2]?.trim().toLowerCase();
    if (value) tags.add(value);
  }
  return [...tags];
}

function getTitle(desc) {
  for (const rawLine of `${desc ?? ""}`.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    return line.replace(/\s+/g, " ").slice(0, 140);
  }
  return "(untitled task)";
}

function hasAnyTag(tags, expected) {
  const tagSet = new Set(tags);
  for (const tag of expected) {
    if (tagSet.has(tag)) return true;
  }
  return false;
}

function inferArea(tags, desc) {
  const tagSet = new Set(tags);
  for (const area of AREA_TAGS) {
    if (tagSet.has(area)) return area;
  }
  const lower = `${desc ?? ""}`.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("jupyter")) return "jupyter";
  if (lower.includes("terminal")) return "terminal";
  if (lower.includes("launchpad")) return "launchpad";
  if (lower.includes("whiteboard")) return "whiteboard";
  if (lower.includes("slate")) return "slate";
  return "general";
}

function inferEnvironment(tags, desc) {
  const tagSet = new Set(tags);
  const lower = `${desc ?? ""}`.toLowerCase();
  if (
    tagSet.has("lite") ||
    lower.includes("lite mode") ||
    lower.includes("lite server") ||
    lower.includes("localhost:700")
  ) {
    return "lite";
  }
  if (
    tagSet.has("hub") ||
    tagSet.has("launchpad") ||
    tagSet.has("compute") ||
    tagSet.has("cloud") ||
    lower.includes("launchpad") ||
    lower.includes("localhost:910")
  ) {
    return "hub";
  }
  return "either";
}

function inferReproQuality(desc) {
  const lower = `${desc ?? ""}`.toLowerCase();
  let score = 0;
  if (/https?:\/\/|http:\/\/localhost/i.test(desc)) score += 2;
  if (
    /\/home\/|\/users\/|[a-z0-9_-]+\.(chat|tasks|board|slides|ipynb|md)\b/i.test(
      desc,
    )
  ) {
    score += 2;
  }
  if (desc.includes("```")) score += 1;
  if (lower.includes("repro") || lower.includes("steps")) score += 1;
  if (lower.includes("![](")) score += 1;
  return score;
}

function inferSeverity(tags, desc) {
  const tagSet = new Set(tags);
  const lower = `${desc ?? ""}`.toLowerCase();
  if (tagSet.has("0")) return "blocker";
  if (tagSet.has("1")) return "high";
  if (tagSet.has("2")) return "medium";
  if (tagSet.has("blocker")) return "blocker";
  if (
    tagSet.has("high") ||
    tagSet.has("critical") ||
    /data loss|cannot start|can't start|fails to start|hard blocker|unusable|crash/.test(
      lower,
    )
  ) {
    return "high";
  }
  if (
    tagSet.has("medium") ||
    /wrong|broken|fails|regression|duplicate|unexpected/.test(lower)
  ) {
    return "medium";
  }
  return "low";
}

function inferStatusHint(task, options = {}) {
  const now = options.now ?? Date.now();
  const staleThresholdMs =
    (options.excludeStaleDays ?? DEFAULT_STALE_DAYS) * 24 * 60 * 60 * 1000;
  const desc = `${task?.desc ?? ""}`;
  const lower = desc.toLowerCase();
  if (
    /already fixed|already-fixed|current code .* matches the fixed path/i.test(
      desc,
    )
  ) {
    return "already_fixed";
  }
  if (
    /could not reproduce|could not confirm|may be stale|appears stale|this task may be stale/i.test(
      desc,
    )
  ) {
    return "stale";
  }
  if (
    /blocked by|failed to sign in|browser automation .* failed|could not reach|hard blocker requiring human input/i.test(
      desc,
    )
  ) {
    return "blocked";
  }
  const tags = extractTags(desc);
  if (tags.includes("today")) return "fresh";
  const lastEdited = Number(task?.last_edited);
  if (Number.isFinite(lastEdited) && now - lastEdited <= staleThresholdMs) {
    return "fresh";
  }
  return "unknown";
}

function severityScore(severity) {
  if (severity === "blocker") return 140;
  if (severity === "high") return 80;
  if (severity === "medium") return 30;
  return 0;
}

function computeScore(candidate) {
  let score = 0;
  score += severityScore(candidate.severity);
  if (candidate.tags.includes("bug")) score += 50;
  if (candidate.tags.includes("today")) score += 20;
  if (candidate.status_hint === "fresh") score += 20;
  if (candidate.status_hint === "unknown") score += 5;
  if (candidate.status_hint === "blocked") score -= 40;
  if (candidate.status_hint === "stale") score -= 120;
  if (candidate.status_hint === "already_fixed") score -= 150;
  score += candidate.repro_quality * 5;
  return score;
}

function toCandidate(task, options = {}) {
  const desc = `${task?.desc ?? ""}`;
  const tags = extractTags(desc);
  const status_hint = inferStatusHint(task, options);
  const candidate = {
    task_id: `${task?.task_id ?? ""}`,
    title: getTitle(desc),
    area: inferArea(tags, desc),
    environment: inferEnvironment(tags, desc),
    tags,
    severity: inferSeverity(tags, desc),
    status_hint,
    repro_quality: inferReproQuality(desc),
    last_edited: Number(task?.last_edited) || undefined,
  };
  candidate.score = computeScore(candidate);
  return candidate;
}

function isOpenTask(task) {
  return task?.done !== true && task?.deleted !== true;
}

function isBugCandidate(task, options = {}) {
  const tags = extractTags(task?.desc ?? "");
  if (options.includeNonBugs) return true;
  return hasAnyTag(tags, BUG_TAGS);
}

function filterCandidates(tasks, options = {}) {
  const areaFilter = new Set(
    (options.areas ?? []).map((value) => value.trim()),
  );
  const environmentFilter = new Set(
    (options.environments ?? []).map((value) => value.trim()),
  );
  const candidates = [];
  for (const task of tasks) {
    if (!isOpenTask(task)) continue;
    if (!isBugCandidate(task, options)) continue;
    const candidate = toCandidate(task, options);
    if (options.freshOnly) {
      if (
        candidate.status_hint === "stale" ||
        candidate.status_hint === "already_fixed"
      ) {
        continue;
      }
    }
    if (areaFilter.size > 0 && !areaFilter.has(candidate.area)) continue;
    if (
      environmentFilter.size > 0 &&
      !environmentFilter.has(candidate.environment)
    ) {
      continue;
    }
    if (
      options.minSeverity &&
      SEVERITY_LEVELS.indexOf(candidate.severity) <
        SEVERITY_LEVELS.indexOf(options.minSeverity)
    ) {
      continue;
    }
    candidates.push(candidate);
  }
  candidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const leftEdited = left.last_edited ?? 0;
    const rightEdited = right.last_edited ?? 0;
    if (leftEdited !== rightEdited) return rightEdited - leftEdited;
    return left.task_id.localeCompare(right.task_id);
  });
  if (options.perArea > 0) {
    const counts = new Map();
    return candidates
      .filter((candidate) => {
        const count = counts.get(candidate.area) || 0;
        if (count >= options.perArea) return false;
        counts.set(candidate.area, count + 1);
        return true;
      })
      .slice(0, options.limit ?? DEFAULT_LIMIT);
  }
  return candidates.slice(0, options.limit ?? DEFAULT_LIMIT);
}

function groupCandidatesByArea(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const current = groups.get(candidate.area) || [];
    current.push(candidate);
    groups.set(candidate.area, current);
  }
  return Array.from(groups.entries())
    .map(([area, items]) => ({ area, candidates: items }))
    .sort((left, right) => {
      const leftScore = left.candidates[0]?.score ?? 0;
      const rightScore = right.candidates[0]?.score ?? 0;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.area.localeCompare(right.area);
    });
}

function formatCandidate(candidate) {
  return [
    `${candidate.score}`.padStart(3, " "),
    `[${candidate.severity}]`,
    `[${candidate.status_hint}]`,
    `[${candidate.environment}]`,
    `[${candidate.area}]`,
    candidate.task_id,
    candidate.title,
  ].join(" ");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const tasks = readTasksFile(options.tasksFile);
  const candidates = filterCandidates(tasks, options);
  const areaGroups = options.groupByArea
    ? groupCandidatesByArea(candidates)
    : [];
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tasksFile: options.tasksFile,
          count: candidates.length,
          candidates,
          ...(options.groupByArea ? { area_groups: areaGroups } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  console.log(`# open bug candidates from ${options.tasksFile}`);
  if (options.groupByArea) {
    for (const group of areaGroups) {
      console.log(`## ${group.area}`);
      for (const candidate of group.candidates) {
        console.log(formatCandidate(candidate));
      }
    }
    return;
  }
  for (const candidate of candidates) {
    console.log(formatCandidate(candidate));
  }
}

module.exports = {
  computeScore,
  extractTags,
  filterCandidates,
  formatCandidate,
  inferArea,
  inferEnvironment,
  inferReproQuality,
  inferSeverity,
  inferStatusHint,
  isBugCandidate,
  isOpenTask,
  parseArgs,
  readTasksFile,
  toCandidate,
  groupCandidatesByArea,
};

if (require.main === module) {
  main();
}
