#!/usr/bin/env node

// Summarize the per-file Jest timings a test lane saved under
// COCALC_TEST_REPORT_DIR (see preserve_test_attempt in workspaces.py): the
// slowest files go to the job summary, and each file over the budget gets a
// warning annotation, so a slow new test shows up on the PR that adds it.
//
//   node scripts/ci-test-timings.mjs <report-dir> [--budget=60] [--top=15]

import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function* jestReports(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jestReports(path);
    else if (/^jest-results-\d+\.json$/.test(entry.name)) yield path;
  }
}

function repoPath(name) {
  const path = relative(REPO_ROOT, name).split(sep).join("/");
  if (!path.startsWith("..")) return path;
  // Reports from another checkout (e.g. a downloaded CI artifact).
  const at = name.lastIndexOf("/src/packages/");
  return at >= 0 ? name.slice(at + 1) : name;
}

/** The slowest single run of each test file, slowest first. */
export function slowestFiles(reportDir) {
  const seconds = new Map();
  for (const path of jestReports(reportDir)) {
    let report;
    try {
      report = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // an interrupted run can leave a partial report
    }
    for (const result of report.testResults ?? []) {
      const { name, startTime, endTime } = result;
      if (!name || !(endTime >= startTime)) continue;
      const file = repoPath(name);
      const s = (endTime - startTime) / 1000;
      seconds.set(file, Math.max(seconds.get(file) ?? 0, s));
    }
  }
  return [...seconds]
    .map(([file, s]) => ({ file, seconds: s }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
}

export function summaryMarkdown(files, { top, budget, title }) {
  if (files.length === 0)
    return `### ${title}\n\nNo Jest timings were saved.\n`;
  const total = files.reduce((sum, { seconds }) => sum + seconds, 0);
  const rows = files
    .slice(0, top)
    .map(
      ({ file, seconds }) =>
        `| ${seconds.toFixed(1)} | ${seconds > budget ? "over budget" : ""} | \`${file}\` |`,
    );
  return [
    `### ${title}`,
    "",
    `${files.length} files, ${total.toFixed(0)} s in total (summed across workers). Budget: ${budget} s per file.`,
    "",
    "| Seconds | | File |",
    "|---:|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { budget: 60, top: 15, title: "Slowest test files" };
  for (const arg of argv) {
    if (arg.startsWith("--budget=")) options.budget = Number(arg.slice(9));
    else if (arg.startsWith("--top=")) options.top = Number(arg.slice(6));
    else if (arg.startsWith("--title=")) options.title = arg.slice(8);
    else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else options.reportDir = arg;
  }
  if (!options.reportDir) throw new Error("provide the report directory");
  if (!(options.budget > 0) || !(options.top > 0)) {
    throw new Error("--budget and --top must be positive numbers");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = slowestFiles(options.reportDir);
  const markdown = summaryMarkdown(files, options);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  for (const { file, seconds } of files) {
    if (seconds <= options.budget) break;
    // Annotations only: a slow file is worth a look, not a failed build.
    console.log(
      `::warning file=${file},title=Slow test file::${file} took ${seconds.toFixed(0)} s (budget ${options.budget} s per file)`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err?.stack ?? err);
    process.exit(1);
  }
}
