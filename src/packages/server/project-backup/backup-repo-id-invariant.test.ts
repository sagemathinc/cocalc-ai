/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A deleted project whose backup_repo_id was never recorded is recorded as
// "no_backup_repo": nothing to purge. That is only true while a host is never
// handed a backup configuration for a project before its backup_repo_id is
// recorded (self-host-local hosts aside), and nothing clears a live project's
// recorded repository. The config paths are pinned in project-backup.test.ts
// (the UPDATE before returning, and that no writer there records a null);
// this pins the "never cleared" half by listing every statement that writes
// projects.backup_repo_id, by the function it is in, and what keeps each one
// from writing a null. A new writer fails this test until it is added here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(__dirname, "..", "..");
const INDEX = "server/project-backup/index.ts";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (
      /\.(ts|tsx|js|mjs)$/.test(name) &&
      !/\.test\.(ts|tsx|js|mjs)$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

const files = sources(PACKAGES).map((path) => ({
  path: relative(PACKAGES, path),
  text: readFileSync(path, "utf8"),
}));

function enclosingFunction(text: string, index: number): string {
  const names = [
    ...text.slice(0, index).matchAll(/^(?:export )?async function (\w+)/gm),
  ];
  return names.length ? names[names.length - 1][1] : "";
}

function functionBody(text: string, name: string): string {
  const start = text.search(
    new RegExp(`^(?:export )?async function ${name}\\b`, "m"),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text
    .slice(start + 1)
    .search(/^(?:export )?(?:async )?function \w+/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

// An UPDATE of the projects table whose SET writes backup_repo_id.
const PROJECTS_WRITE =
  /UPDATE\s+projects\s+SET\b[^;"`]*?\bbackup_repo_id\s*=\s*([^\s,"`]+)/gi;

const writers = files.flatMap(({ path, text }) =>
  [...text.matchAll(PROJECTS_WRITE)].map((match) => ({
    path,
    fn: enclosingFunction(text, match.index!),
    value: match[1],
    index: match.index!,
  })),
);
const index = files.find(({ path }) => path === INDEX)!.text;

it("these are every statement that writes projects.backup_repo_id", () => {
  expect(
    writers.map(({ path, fn, value }) => `${path} ${fn} ${value}`),
  ).toEqual([
    `${INDEX} assignProjectBackupRepo $2`,
    `${INDEX} releaseProjectBackupRepoAssignmentLocal NULL`,
    `${INDEX} setProjectBackupRepoId $2`,
    `${INDEX} resolveProjectBackupRepoAssignment $2`,
    `${INDEX} releaseProjectBackupRepoAssignment NULL`,
    `${INDEX} getSeedManagedProjectBackupConfig $2`,
  ]);
});

it("no caller asks to clear a project's recorded backup repository", () => {
  const callers = files
    .filter(({ text }) => /clear_local_backup_repo_id\s*:\s*true/.test(text))
    .map(({ path }) => path);
  expect(callers).toEqual([]);
});

it("the two clears sit behind the explicit clear option", () => {
  for (const { value, index: at } of writers) {
    if (value !== "NULL") continue;
    const before = index.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/if \(clear_local_backup_repo_id\) \{\s*await/);
  }
});

it("the writers of a value never write a null", () => {
  // assignProjectBackupRepo writes the id of the repository row it was given
  expect(functionBody(index, "assignProjectBackupRepo")).toMatch(
    /\[project_id, repo\.id\],/,
  );
  // setProjectBackupRepoId takes only a repository id, never a null
  const setter = functionBody(index, "setProjectBackupRepoId");
  expect(setter).toMatch(/backup_repo_id: string;/);
  expect(setter).toMatch(
    /if \(!backup_repo_id \|\| !isValidUUID\(backup_repo_id\)\) \{\s*throw/,
  );
  expect(setter).not.toMatch(/DELETE FROM project_backup_repo_assignments/);
  // the seed's answers are recorded only when they name a repository
  for (const [fn, guard] of [
    ["resolveProjectBackupRepoAssignment", /if \(result\.backup_repo_id\) \{/],
    [
      "getSeedManagedProjectBackupConfig",
      /if \(config\.backup_repo_id && config\.toml\) \{/,
    ],
  ] as const) {
    const writer = writers.find((w) => w.fn === fn)!;
    const before = index.slice(Math.max(0, writer.index - 200), writer.index);
    expect(before).toMatch(
      new RegExp(`${guard.source}\\s*await pool\\(\\)\\.query\\(\\s*["\x60]$`),
    );
  }
});
