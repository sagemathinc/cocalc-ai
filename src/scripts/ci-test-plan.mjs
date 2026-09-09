#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const PACKAGES_DIR = join(SRC_ROOT, "packages");
const SKIP_DIRS = new Set(["build", "dist", "node_modules"]);
const FULL_SUITE_FILES = new Set([
  ".github/workflows/make-and-test.yml",
  "src/package.json",
  "src/packages/package.json",
  "src/packages/pnpm-lock.yaml",
  "src/packages/pnpm-workspace.yaml",
  "src/scripts/ci-test-plan.mjs",
  "src/workspaces.py",
]);

export function discoverWorkspaces(dir = PACKAGES_DIR) {
  const workspaces = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const manifestPath = join(path, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      workspaces.push({
        name: basename(path),
        path,
        relativePath: relative(REPO_ROOT, path).split(sep).join("/"),
        manifest,
      });
    }
    workspaces.push(...discoverWorkspaces(path));
  }
  return workspaces.sort((a, b) => a.path.localeCompare(b.path));
}

export function isDocumentationOnly(path) {
  return (
    path.startsWith("docs/") || path.endsWith(".md") || path.endsWith(".mdx")
  );
}

export function requiresFullSuite(changedFiles) {
  return changedFiles.some((path) => {
    if (FULL_SUITE_FILES.has(path)) return true;
    if (path.startsWith(".github/actions/")) return true;
    if (path.startsWith("src/packages/tsconfig")) return true;
    if (path.startsWith("src/packages/.oxlint")) return true;
    if (path.startsWith("src/scripts/") && !isDocumentationOnly(path)) {
      return true;
    }
    if (!path.startsWith("src/packages/") && !isDocumentationOnly(path)) {
      return true;
    }
    return false;
  });
}

export function directlyChangedPackages(changedFiles, workspaces) {
  return workspaces
    .filter(({ relativePath }) =>
      changedFiles.some(
        (path) => path === relativePath || path.startsWith(`${relativePath}/`),
      ),
    )
    .map(({ name }) => name)
    .sort();
}

export function createPlan({
  workspaces,
  changedFiles = [],
  affectedPackages = [],
  full = false,
  base,
}) {
  const testPackages = workspaces
    .filter(({ manifest }) =>
      Boolean(
        manifest.scripts?.test ||
        manifest.scripts?.["test:all"] ||
        manifest.scripts?.["test-github-ci"],
      ),
    )
    .map(({ name }) => name);
  const testPackageSet = new Set(testPackages);
  const runFull = full || requiresFullSuite(changedFiles);
  const selected = (runFull ? testPackages : affectedPackages)
    .filter((name) => testPackageSet.has(name))
    .sort();
  const selectedSet = new Set(selected);
  const direct = directlyChangedPackages(changedFiles, workspaces);
  const depcheckCandidates = runFull
    ? workspaces.map(({ name }) => name)
    : direct;
  const depcheckPackages = depcheckCandidates
    .filter((name) => {
      const workspace = workspaces.find((item) => item.name === name);
      return Boolean(workspace?.manifest.scripts?.depcheck);
    })
    .sort();
  const lanes = [];
  if (selectedSet.delete("server")) {
    for (let index = 1; index <= 2; index++) {
      lanes.push({
        lane: `server-${index}`,
        packages: "server",
        shard: `${index}/2`,
      });
    }
  }
  if (selectedSet.delete("frontend")) {
    lanes.push({ lane: "frontend", packages: "frontend" });
  }
  const rest = [...selectedSet].sort();
  if (rest.length) {
    lanes.push({ lane: "rest", packages: rest.join(",") });
  }
  return {
    mode: runFull ? "full" : "affected",
    base,
    changedFiles,
    selectedPackages: selected,
    directPackages: direct,
    depcheckPackages,
    lanes,
    hasTests: lanes.length > 0,
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function changedFilesSince(base) {
  if (!base) return [];
  return run(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
    REPO_ROOT,
  )
    .split("\n")
    .filter(Boolean);
}

function affectedPackagesSince(base) {
  if (!base) return [];
  const output = run(
    "pnpm",
    ["--filter", `...[${base}]`, "list", "--depth=-1", "--json"],
    PACKAGES_DIR,
  );
  return (output ? JSON.parse(output) : []).map(({ path }) => basename(path));
}

function parseArgs(argv) {
  const options = { full: false, githubOutput: false, pretty: false };
  for (const arg of argv) {
    if (arg === "--full") options.full = true;
    else if (arg === "--github-output") options.githubOutput = true;
    else if (arg === "--pretty") options.pretty = true;
    else if (arg.startsWith("--base=")) options.base = arg.slice(7);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function writeGithubOutput(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required with --github-output");
  }
  const lines = [
    `matrix=${JSON.stringify({ include: plan.lanes })}`,
    `has_tests=${plan.hasTests}`,
    `mode=${plan.mode}`,
    `depcheck_packages=${plan.depcheckPackages.join(",")}`,
  ];
  appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.full && !options.base) {
    throw new Error("provide --full or --base=<git revision>");
  }
  const workspaces = discoverWorkspaces();
  const changedFiles = options.full ? [] : changedFilesSince(options.base);
  const plan = createPlan({
    workspaces,
    changedFiles,
    affectedPackages: options.full ? [] : affectedPackagesSince(options.base),
    full: options.full,
    base: options.base,
  });
  if (options.githubOutput) writeGithubOutput(plan);
  console.log(JSON.stringify(plan, null, options.pretty ? 2 : 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err?.stack ?? err);
    process.exit(1);
  }
}
