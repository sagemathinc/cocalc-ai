import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerProjectCodexCommands } from "./codex";

const KEY = "sk-test-synthetic-key";
const SET = ["node", "test", "project", "codex", "auth", "api-key", "set"];

function makeProgram(
  calls: any[],
  {
    failFirst = false,
    stdinReads = { count: 0 },
  }: { failFirst?: boolean; stdinReads?: { count: number } } = {},
): Command {
  const program = new Command();
  program.exitOverride();
  // Like the real root command, which owns --api-key for the CoCalc key.
  program.option("--api-key <key>", "account api key");
  const project = program.command("project");
  let attempts = 0;
  const ctx = {
    hub: {
      system: {
        setOpenAiApiKey: async (opts: any) => {
          attempts += 1;
          if (failFirst && attempts === 1) {
            throw new Error("fresh authentication required");
          }
          calls.push(opts);
          return { id: "credential-1", created: new Date(0) };
        },
      },
    },
  };
  registerProjectCodexCommands(project, {
    // Like the real withContext, rerun the callback once after a failure
    // (it elevates and retries when fresh authentication is required).
    withContext: async (_command, _label, fn) => {
      try {
        await fn(ctx);
      } catch (err) {
        if (!failFirst) throw err;
        await fn(ctx);
      }
    },
    resolveProjectFromArgOrContext: async (_ctx: any, project?: string) => ({
      project_id: project ?? "target-project",
      title: "Target",
    }),
    readAllStdin: async () => {
      stdinReads.count += 1;
      return stdinReads.count === 1 ? `${KEY}\n` : "";
    },
    toIso: (value: any) => value,
  } as any);
  return program;
}

test("api-key set takes the key from --openai-api-key", async () => {
  const calls: any[] = [];
  await makeProgram(calls).parseAsync([
    ...SET,
    "-w",
    "p1",
    "--openai-api-key",
    KEY,
  ]);
  assert.deepEqual(calls, [{ project_id: "p1", api_key: KEY }]);
});

test("api-key set reads the key from stdin", async () => {
  const calls: any[] = [];
  await makeProgram(calls).parseAsync([...SET, "-w", "p1", "--stdin"]);
  assert.deepEqual(calls, [{ project_id: "p1", api_key: KEY }]);
});

test("api-key set reads stdin once across a fresh-auth retry", async () => {
  const calls: any[] = [];
  const stdinReads = { count: 0 };
  await makeProgram(calls, { failFirst: true, stdinReads }).parseAsync([
    ...SET,
    "-w",
    "p1",
    "--stdin",
  ]);
  assert.equal(stdinReads.count, 1);
  assert.deepEqual(calls, [{ project_id: "p1", api_key: KEY }]);
});

test("api-key set reads the key from a private file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-key-"));
  try {
    const file = join(dir, "key");
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    const calls: any[] = [];
    await makeProgram(calls).parseAsync([
      ...SET,
      "--scope",
      "account",
      "--key-file",
      file,
    ]);
    assert.deepEqual(calls, [{ api_key: KEY }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api-key set never uses the root --api-key as the OpenAI key", async () => {
  const calls: any[] = [];
  await assert.rejects(
    makeProgram(calls).parseAsync([...SET, "-w", "p1", "--api-key", KEY]),
    /exactly one of --openai-api-key, --key-file or --stdin/,
  );
  assert.deepEqual(calls, []);
});

test("api-key set rejects two key sources", async () => {
  const calls: any[] = [];
  await assert.rejects(
    makeProgram(calls).parseAsync([
      ...SET,
      "-w",
      "p1",
      "--stdin",
      "--openai-api-key",
      KEY,
    ]),
    /exactly one of/,
  );
  assert.deepEqual(calls, []);
});
