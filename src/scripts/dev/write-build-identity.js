#!/usr/bin/env node

// Keep this helper plain JS so bundle build scripts can run before TypeScript
// compilation. Keep the generated metadata shape aligned with
// packages/util/build-identity.ts.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return `${result.stdout ?? ""}`.trim();
}

function compactBuildTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function shortGitCommit(commit, length = 12) {
  const normalized = `${commit ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.slice(0, Math.max(4, length));
}

function normalizeHashFragment(value, length = 8) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.replace(/[^a-z0-9]/g, "").slice(0, Math.max(4, length)) || undefined;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(opts.root || process.cwd());
  const outFile = path.resolve(opts.out || "");
  const packageRoot = path.resolve(opts["package-root"] || "");
  const artifactKind = `${opts["artifact-kind"] ?? ""}`.trim() || undefined;
  if (!outFile) {
    throw new Error("--out is required");
  }
  if (!packageRoot) {
    throw new Error("--package-root is required");
  }

  const pkg = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const gitCommit = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const gitStatus = runGit(repoRoot, ["status", "--porcelain"]);
  const gitDirty = gitStatus.length > 0;
  const gitDiff = gitDirty
    ? spawnSync("git", ["diff", "--no-ext-diff", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }).stdout ?? ""
    : "";
  const gitDiffHash = gitDirty
    ? crypto.createHash("sha256").update(gitDiff).digest("hex")
    : undefined;
  const builtAt = new Date();
  const buildId = [
    compactBuildTimestamp(builtAt),
    shortGitCommit(gitCommit) ?? "nogit",
    ...(gitDirty ? ["dirty", normalizeHashFragment(gitDiffHash)].filter(Boolean) : []),
  ].join("-");
  const identity = {
    build_id: buildId,
    built_at: builtAt.toISOString(),
    git_commit: gitCommit || undefined,
    git_commit_short: shortGitCommit(gitCommit),
    git_dirty: gitDirty,
    git_diff_hash: normalizeHashFragment(gitDiffHash),
    package_version: `${pkg.version ?? ""}`.trim() || undefined,
    artifact_kind: artifactKind,
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(identity, null, 2)}\n`);
  process.stdout.write(`${identity.build_id}\n`);
}

main();
