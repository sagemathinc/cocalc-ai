// Guards the TypeScript 7 setup (src/.agents/typescript-7-migration-plan-2026-07-15.md):
// - no tsconfig may use compiler options that TypeScript 7 removed;
// - the workspace root must declare every @cocalc package, because the shared
//   "@cocalc/*" paths mapping in packages/tsconfig.json resolves workspace
//   imports to source through packages/node_modules/@cocalc;
// - "typescript" must stay the TypeScript 6 compatibility package, which only
//   provides the compiler API that ts-jest and a few scripts need. The tsc
//   compiler is TypeScript 7, installed as "@typescript/native".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REMOVED_OPTIONS = [
  [/"baseUrl"\s*:/, "baseUrl is removed in TypeScript 7; use paths"],
  [/"downlevelIteration"\s*:/, "downlevelIteration is removed in TypeScript 7"],
  [
    /"moduleResolution"\s*:\s*"(node|node10|classic)"/i,
    'moduleResolution must not be "node"/"node10"/"classic"; inherit "bundler"',
  ],
];

const TYPESCRIPT_API = /^npm:@typescript\/typescript6@/;
const TYPESCRIPT_NATIVE = /^npm:typescript@\^?7\./;

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
    .filter((name) => name.startsWith("@cocalc/"))
    .filter((name) => declared[name] !== "workspace:*")
    .map(
      (name) =>
        `src/packages/package.json: add "${name}": "workspace:*" to devDependencies`,
    );
}

export function typescriptDependencyErrors(path, pkg) {
  const errors = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = pkg[section] ?? {};
    if (deps.typescript != null && !TYPESCRIPT_API.test(deps.typescript)) {
      errors.push(
        `${path}: "typescript" must be "npm:@typescript/typescript6@..." (the compiler API for ts-jest); tsc is "@typescript/native"`,
      );
    }
    const native = deps["@typescript/native"];
    if (native != null && !TYPESCRIPT_NATIVE.test(native)) {
      errors.push(
        `${path}: "@typescript/native" must be "npm:typescript@^7..."`,
      );
    }
  }
  return errors;
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
    } else if (name === "package.json") {
      const pkg = JSON.parse(readFileSync(join(root, path), "utf8"));
      errors.push(...typescriptDependencyErrors(path, pkg));
      if (path !== "src/packages/package.json" && pkg.name) {
        workspaceNames.push(pkg.name);
      }
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
