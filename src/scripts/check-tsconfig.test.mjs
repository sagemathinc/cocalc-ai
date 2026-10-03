import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkTsconfig,
  missingWorkspaceLinks,
  removedOptionErrors,
  typescriptDependencyErrors,
} from "./check-tsconfig.mjs";

test("flags compiler options removed in TypeScript 7", () => {
  const text = `{
    "compilerOptions": {
      "baseUrl": ".",
      "downlevelIteration": true,
      "moduleResolution": "Node"
    }
  }`;
  assert.equal(removedOptionErrors("a/tsconfig.json", text).length, 3);
});

test("accepts the bundler resolver and paths", () => {
  const text = `{
    "compilerOptions": {
      "moduleResolution": "bundler",
      "paths": { "@cocalc/*": ["./node_modules/@cocalc/*"] }
    }
  }`;
  assert.deepEqual(removedOptionErrors("a/tsconfig.json", text), []);
});

test("requires root workspace links for every @cocalc package", () => {
  const root = {
    devDependencies: { "@cocalc/util": "workspace:*", "@cocalc/sync": "^1.0" },
  };
  assert.deepEqual(
    missingWorkspaceLinks(root, [
      "@cocalc/util",
      "@cocalc/sync",
      "@cocalc/conat",
      "some-vendored-package",
    ]),
    [
      'src/packages/package.json: add "@cocalc/sync": "workspace:*" to devDependencies',
      'src/packages/package.json: add "@cocalc/conat": "workspace:*" to devDependencies',
    ],
  );
});

test("keeps typescript as the TypeScript 6 API and tsc as TypeScript 7", () => {
  const ok = {
    devDependencies: {
      "@typescript/native": "npm:typescript@^7.0.2",
      typescript: "npm:@typescript/typescript6@^6.0.2",
    },
  };
  assert.deepEqual(typescriptDependencyErrors("p/package.json", ok), []);
  const bad = {
    devDependencies: {
      "@typescript/native": "npm:typescript@^6.0.3",
      typescript: "^7.0.2",
    },
  };
  assert.equal(typescriptDependencyErrors("p/package.json", bad).length, 2);
});

test("the repository scan checks compiler dependencies in root and workspace manifests", (t) => {
  const root = mkdtempSync(join(tmpdir(), "check-tsconfig-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rootPath = "src/packages/package.json";
  const packagePath = "src/packages/apps/example/package.json";
  const write = (path, pkg) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(pkg));
  };
  const rootPackage = {
    devDependencies: {
      "@cocalc/example": "workspace:*",
      "@typescript/native": "npm:typescript@^7.0.2",
      typescript: "npm:@typescript/typescript6@^6.0.2",
    },
  };
  const workspacePackage = { name: "@cocalc/example" };
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  write(rootPath, rootPackage);
  write(packagePath, workspacePackage);
  execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
  assert.deepEqual(checkTsconfig(root), []);

  for (const path of [rootPath, packagePath]) {
    for (const section of ["dependencies", "devDependencies"]) {
      write(rootPath, rootPackage);
      write(packagePath, workspacePackage);
      write(path, {
        ...(path === rootPath ? rootPackage : workspacePackage),
        [section]: {
          ...(path === rootPath ? rootPackage.devDependencies : {}),
          "@typescript/native": "npm:typescript@^6.0.3",
          typescript: "^7.0.2",
        },
      });
      const errors = checkTsconfig(root);
      assert.equal(errors.length, 2, `${path}: ${section}`);
      assert.ok(errors.every((error) => error.startsWith(`${path}:`)));
    }
  }
});

test("the repository passes", () => {
  assert.deepEqual(checkTsconfig(), []);
});
