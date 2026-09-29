// Guards the TypeScript 7 migration (src/.agents/typescript-7-migration-plan-2026-07-15.md):
// - no tsconfig may use compiler options that TypeScript 7 removed;
// - the workspace root must declare every @cocalc package, because the shared
//   "@cocalc/*" paths mapping in packages/tsconfig.json resolves workspace
//   imports to source through packages/node_modules/@cocalc.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REMOVED_OPTIONS = [
  [/"baseUrl"\s*:/, "baseUrl is removed in TypeScript 7; use paths"],
  [/"downlevelIteration"\s*:/, "downlevelIteration is removed in TypeScript 7"],
  [
    /"ignoreDeprecations"\s*:/,
    "ignoreDeprecations is obsolete in TypeScript 7",
  ],
  [
    /"moduleResolution"\s*:\s*"(node|node10|classic)"/i,
    'moduleResolution must not be "node"/"node10"/"classic"; inherit "bundler"',
  ],
];

// The root package itself and the helper that only installs the TS7 compiler.
const NOT_LINKED = new Set(["@cocalc/typescript-native"]);

// Mirrors the exclusions in packages/pnpm-workspace.yaml.
function isOutsideWorkspace(path) {
  return (
    path.startsWith("src/packages/project/managed-harnesses/") ||
    path
      .split("/")
      .some((part) => ["node_modules", "dist", "build"].includes(part))
  );
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "src/packages"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path && !isOutsideWorkspace(path));
}

export function removedOptionErrors(path, text) {
  return REMOVED_OPTIONS.filter(([pattern]) => pattern.test(text)).map(
    ([, message]) => `${path}: ${message}`,
  );
}

export function missingWorkspaceLinks(rootPackage, workspaceNames) {
  const declared = {
    ...rootPackage.dependencies,
    ...rootPackage.devDependencies,
  };
  return workspaceNames
    .filter((name) => name.startsWith("@cocalc/") && !NOT_LINKED.has(name))
    .filter((name) => declared[name] !== "workspace:*")
    .map(
      (name) =>
        `src/packages/package.json: add "${name}": "workspace:*" to devDependencies`,
    );
}

export function checkTsconfig(root = ROOT) {
  const files = trackedFiles(root);
  const errors = [];
  const workspaceNames = [];
  for (const path of files) {
    const name = basename(path);
    if (/^tsconfig(?:\..+)?\.json$/.test(name)) {
      errors.push(
        ...removedOptionErrors(path, readFileSync(join(root, path), "utf8")),
      );
    } else if (
      name === "package.json" &&
      path !== "src/packages/package.json"
    ) {
      const pkg = JSON.parse(readFileSync(join(root, path), "utf8"));
      if (pkg.name) workspaceNames.push(pkg.name);
    }
  }
  const rootPackage = JSON.parse(
    readFileSync(join(root, "src/packages/package.json"), "utf8"),
  );
  errors.push(...missingWorkspaceLinks(rootPackage, workspaceNames));
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkTsconfig();
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
}
