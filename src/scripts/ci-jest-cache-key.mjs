import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function isJestCacheInput(path) {
  if (!path.startsWith("src/packages/")) return false;
  if (
    path
      .split("/")
      .some((part) =>
        ["node_modules", "dist", "dist-ts", "build"].includes(part),
      )
  ) {
    return false;
  }
  const name = basename(path);
  return (
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(name) ||
    /^tsconfig(?:\..+)?\.json$/.test(name) ||
    /^(?:jest|babel)\.config\.(?:[cm]?[jt]s|json)$/.test(name) ||
    /^\.babelrc(?:\.[cm]?js|\.json)?$/.test(name)
  );
}

export function jestCacheKey(root = ROOT) {
  // Git's tracked file list avoids traversing pnpm's installed dependency graph.
  const files = execFileSync("git", ["ls-files", "-z", "--", "src/packages"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(isJestCacheInput)
    .sort();
  if (!files.includes("src/packages/pnpm-lock.yaml")) {
    throw new Error("No tracked workspace lockfile found for Jest cache key");
  }
  const hash = createHash("sha256");
  for (const path of files) {
    // Include names and frame contents so renames and deletions invalidate caches.
    hash.update(
      JSON.stringify([path, readFileSync(resolve(root, path), "utf8")]),
    );
  }
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--github-output")) {
    throw new Error("Usage: ci-jest-cache-key.mjs [--github-output]");
  }
  const key = jestCacheKey();
  if (args.includes("--github-output")) {
    if (!process.env.GITHUB_OUTPUT)
      throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  }
  console.log(key);
}
