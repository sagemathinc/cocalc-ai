/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editProjectFile,
  readProjectFile,
  writeProjectFile,
} from "./claude-project-file-tools";
import type { ProjectJobExecutor } from "./claude-project-jobs";

let scripts: string[] = [];
let beforeScript: ((script: string) => Promise<void>) | undefined;
// Runs each script locally, streaming output like the managed executor.
const execute: ProjectJobExecutor = async (script, cwd, _signal, options) => {
  scripts.push(script);
  await beforeScript?.(script);
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], { cwd });
    child.stdout.on("data", (d) => options.onOutput("stdout", `${d}`));
    child.stderr.on("data", (d) => options.onOutput("stderr", `${d}`));
    child.on("close", (code) =>
      resolve({ stdout: "", stderr: "", code, cleanupConfirmed: true }),
    );
  });
};
const signal = new AbortController().signal;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "file-tools-"));
  scripts = [];
  beforeScript = undefined;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("reads numbered lines with offset and limit", async () => {
  const path = join(dir, "it's $(x) `y`;.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  expect(await readProjectFile(execute, { path }, signal)).toEqual({
    path,
    total_lines: 4,
    start_line: 1,
    end_line: 4,
    truncated: false,
    content: "     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour",
  });
  expect(
    await readProjectFile(execute, { path, offset: 2, limit: 2 }, signal),
  ).toMatchObject({
    start_line: 2,
    end_line: 3,
    content: "     2\ttwo\n     3\tthree",
  });
  const noNewline = join(dir, "last.txt");
  await writeFile(noNewline, "a\nb");
  expect(
    await readProjectFile(execute, { path: noNewline }, signal),
  ).toMatchObject({ total_lines: 2, content: "     1\ta\n     2\tb" });
});

test("refuses binary files and bad arguments", async () => {
  const path = join(dir, "bin");
  await writeFile(path, Buffer.from([1, 0, 2]));
  expect(await readProjectFile(execute, { path }, signal)).toEqual({
    error: expect.stringContaining("looks binary"),
  });
  expect(await readProjectFile(execute, { path: "" }, signal)).toEqual({
    error: "path must be a non-empty file path",
  });
  expect(await readProjectFile(execute, { path, offset: 0 }, signal)).toEqual({
    error: "offset must be a positive line number",
  });
  expect(
    await readProjectFile(execute, { path: join(dir, "missing") }, signal),
  ).toEqual({ error: expect.stringContaining("not a readable file") });
});

test("edits an exact unique string and keeps permissions", async () => {
  const path = join(dir, "code.sh");
  await writeFile(path, "#!/bin/sh\necho 'old value'\n");
  await chmod(path, 0o750);
  expect(
    await editProjectFile(
      execute,
      { path, old_string: "'old value'", new_string: "'new value'" },
      signal,
    ),
  ).toEqual({ path, replacements: 1 });
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho 'new value'\n");
  expect((await stat(path)).mode & 0o777).toBe(0o750);
});

test("refuses missing or ambiguous matches unless replace_all", async () => {
  const path = join(dir, "a.txt");
  await writeFile(path, "x = 1\nx = 1\n");
  expect(
    await editProjectFile(
      execute,
      { path, old_string: "y", new_string: "z" },
      signal,
    ),
  ).toEqual({ error: expect.stringContaining("was not found") });
  expect(
    await editProjectFile(
      execute,
      { path, old_string: "x = 1", new_string: "x = 2" },
      signal,
    ),
  ).toEqual({ error: expect.stringContaining("occurs 2 times") });
  expect(
    await editProjectFile(
      execute,
      { path, old_string: "x = 1", new_string: "x = 2", replace_all: true },
      signal,
    ),
  ).toEqual({ path, replacements: 2 });
  expect(await readFile(path, "utf8")).toBe("x = 2\nx = 2\n");
});

test("refuses an edit when the file changes before the replace", async () => {
  const path = join(dir, "race.txt");
  await writeFile(path, "alpha\n");
  beforeScript = async (script) => {
    if (script.includes("mv -f")) await writeFile(path, "changed\n");
  };
  expect(
    await editProjectFile(
      execute,
      { path, old_string: "alpha", new_string: "beta" },
      signal,
    ),
  ).toEqual({ error: expect.stringContaining("file changed") });
  expect(await readFile(path, "utf8")).toBe("changed\n");
});

test("writes large content in chunks through symlinks", async () => {
  const target = join(dir, "real.txt");
  await writeFile(target, "old");
  const link = join(dir, "link.txt");
  await symlink(target, link);
  const content = "line of text ✓\n".repeat(20_000); // ~320 KB
  expect(
    await writeProjectFile(execute, { path: link, content }, signal),
  ).toEqual({
    path: link,
    bytes: Buffer.byteLength(content),
  });
  expect(await readFile(target, "utf8")).toBe(content);
  expect((await stat(link, { bigint: false })).isFile()).toBe(true);
  // Multiple chunk scripts, each well under the per-argument limit.
  expect(scripts.filter((s) => s.includes("base64 -d")).length).toBeGreaterThan(
    1,
  );
  expect(Math.max(...scripts.map((s) => s.length))).toBeLessThan(110_000);
});

test("creates parent directories only when asked", async () => {
  const path = join(dir, "new", "deep", "file.txt");
  expect(
    await writeProjectFile(execute, { path, content: "hi" }, signal),
  ).toEqual({ error: expect.stringContaining("create_dirs") });
  expect(
    await writeProjectFile(
      execute,
      { path, content: "hi", create_dirs: true },
      signal,
    ),
  ).toEqual({ path, bytes: 2 });
  expect(await readFile(path, "utf8")).toBe("hi");
  expect(
    await writeProjectFile(execute, { path, content: "" }, signal),
  ).toEqual({ path, bytes: 0 });
  expect(await readFile(path, "utf8")).toBe("");
});
