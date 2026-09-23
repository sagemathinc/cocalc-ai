import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import * as grants from "./agent-file-grant";
import { registerProjectFileCommands } from "../commands/project/file";

test("grant mutation CLI uses the identity-only connection and closes on success or denial", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grant-cli-"));
  const local = join(dir, "input");
  await writeFile(local, "hello");
  const calls: any[] = [];
  let mode = "read-write";
  let closed = 0;
  const errors: any[] = [];
  t.mock.method(grants, "openAgentFileGrant", async (opts) => {
    assert.equal(opts.projectId, "target");
    return {
      prepared: { grant: { mode, target_project_id: "target" } },
      fs: Object.fromEntries(
        ["writeFile", "mkdir", "rename", "copyFile", "rm"].map((name) => [
          name,
          async (...args) => {
            calls.push([name, ...args]);
          },
        ]),
      ),
      close: () => {
        closed++;
      },
    };
  });
  const program = new Command();
  registerProjectFileCommands(program.command("project"), {
    globalsFrom: () => ({}),
    emitSuccess: () => {},
    emitError: (...args) => errors.push(args),
  } as any);
  const run = async (...args: string[]) =>
    program.parseAsync(
      ["project", "file", "grant", ...args, "--project", "target"],
      { from: "user" },
    );
  try {
    await run("put", local, "docs/a");
    await run("mkdir", "docs/sub", "--parents");
    await run("copy", "docs/a", "docs/b");
    await run("rename", "docs/b", "docs/c");
    await run("rm", "docs/sub", "--recursive");
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["writeFile", "mkdir", "copyFile", "rename", "rm"],
    );
    assert.equal(calls[0][2].toString(), "hello");
    assert.deepEqual(calls[1][2], { recursive: true });
    assert.equal(closed, 5);
    assert.equal(errors.length, 0);
    mode = "read";
    await run("rm", "docs/a");
    assert.equal(calls.length, 5);
    assert.equal(errors.length, 1);
    assert.equal(closed, 6);
  } finally {
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
});
