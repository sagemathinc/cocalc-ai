#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_REPO_SKILLS_ROOT = path.join(ROOT, ".skills");
const DEFAULT_LOCAL_SKILLS_ROOT = path.join(os.homedir(), ".codex", "skills");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: sync-codex-skill.js <skill-name> <diff|push|pull> [--dry-run] [--json] [--delete-extra] [--repo-root <path>] [--local-root <path>]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const skillName = argv[0];
  const action = argv[1];
  if (!skillName || !action) {
    usageAndExit("skill name and action are required");
  }
  if (!["diff", "push", "pull"].includes(action)) {
    usageAndExit(`unsupported action: ${action}`);
  }
  const options = {
    skillName,
    action,
    dryRun: false,
    json: false,
    deleteExtra: false,
    repoRoot: DEFAULT_REPO_SKILLS_ROOT,
    localRoot: DEFAULT_LOCAL_SKILLS_ROOT,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--delete-extra") {
      options.deleteExtra = true;
    } else if (arg === "--repo-root") {
      options.repoRoot = path.resolve(
        argv[++i] || usageAndExit("--repo-root requires a path"),
      );
    } else if (arg === "--local-root") {
      options.localRoot = path.resolve(
        argv[++i] || usageAndExit("--local-root requires a path"),
      );
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function collectFiles(root) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.set(path.relative(root, fullPath), fs.readFileSync(fullPath));
    }
  }
  return files;
}

function planSync(sourceRoot, destRoot) {
  const sourceFiles = collectFiles(sourceRoot);
  const destFiles = collectFiles(destRoot);
  const copy = [];
  const update = [];
  const identical = [];
  const extra = [];

  for (const [relativePath, sourceContent] of sourceFiles.entries()) {
    const destContent = destFiles.get(relativePath);
    if (destContent == null) {
      copy.push(relativePath);
      continue;
    }
    if (Buffer.compare(sourceContent, destContent) === 0) {
      identical.push(relativePath);
    } else {
      update.push(relativePath);
    }
  }
  for (const relativePath of destFiles.keys()) {
    if (!sourceFiles.has(relativePath)) {
      extra.push(relativePath);
    }
  }
  copy.sort();
  update.sort();
  identical.sort();
  extra.sort();
  return { copy, update, identical, extra };
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function applyPlan(sourceRoot, destRoot, plan, options = {}) {
  if (!options.dryRun) {
    fs.mkdirSync(destRoot, { recursive: true });
  }
  for (const relativePath of [...plan.copy, ...plan.update]) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destPath = path.join(destRoot, relativePath);
    if (options.dryRun) continue;
    ensureDirForFile(destPath);
    fs.copyFileSync(sourcePath, destPath);
  }
  if (options.deleteExtra) {
    for (const relativePath of plan.extra) {
      if (options.dryRun) continue;
      fs.rmSync(path.join(destRoot, relativePath), { force: true });
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repoSkillRoot = path.join(options.repoRoot, options.skillName);
  const localSkillRoot = path.join(options.localRoot, options.skillName);
  const sourceRoot = options.action === "pull" ? localSkillRoot : repoSkillRoot;
  const destRoot = options.action === "pull" ? repoSkillRoot : localSkillRoot;
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`source skill does not exist: ${sourceRoot}`);
  }
  const plan = planSync(sourceRoot, destRoot);
  const payload = {
    action: options.action,
    skill: options.skillName,
    sourceRoot,
    destRoot,
    dryRun: options.dryRun,
    deleteExtra: options.deleteExtra,
    ...plan,
  };
  if (options.action !== "diff") {
    applyPlan(sourceRoot, destRoot, plan, options);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  console.log(`${options.action} ${options.skillName}`);
  console.log(`source: ${sourceRoot}`);
  console.log(`dest:   ${destRoot}`);
  console.log(`copy:   ${plan.copy.length}`);
  console.log(`update: ${plan.update.length}`);
  console.log(`extra:  ${plan.extra.length}`);
  if (plan.copy.length > 0) {
    console.log("copy files:");
    for (const relativePath of plan.copy) console.log(`- ${relativePath}`);
  }
  if (plan.update.length > 0) {
    console.log("update files:");
    for (const relativePath of plan.update) console.log(`- ${relativePath}`);
  }
  if (plan.extra.length > 0) {
    console.log(
      options.deleteExtra ? "delete extra files:" : "extra destination files:",
    );
    for (const relativePath of plan.extra) console.log(`- ${relativePath}`);
  }
}

module.exports = {
  applyPlan,
  collectFiles,
  parseArgs,
  planSync,
};

if (require.main === module) {
  main();
}
