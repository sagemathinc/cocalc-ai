import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerProjectCodexCommands } from "./codex";

const KEY = "sk-test-synthetic-key";

function makeProgram(calls: any[]): Command {
  const program = new Command();
  program.exitOverride();
  // Like the real root command, which owns --api-key for the CoCalc key.
  program.option("--api-key <key>", "account api key");
  const project = program.command("project");
  registerProjectCodexCommands(project, {
    withContext: async (_command, _label, fn) => {
      await fn({
        hub: {
          system: {
            setOpenAiApiKey: async (opts: any) => {
              calls.push(opts);
              return { id: "credential-1", created: new Date(0) };
            },
          },
        },
      });
    },
    resolveProjectFromArgOrContext: async (_ctx: any, project?: string) => ({
      project_id: project ?? "target-project",
      title: "Target",
    }),
    readAllStdin: async () => `${KEY}\n`,
    toIso: (value: any) => value,
  } as any);
  return program;
}

function setArgs(...args: string[]): string[] {
  return ["node", "test", "project", "codex", "auth", "api-key", "set", ...args];
}

test("api-key set takes the key from --openai-api-key", async () => {
  const calls: any[] = [];
  await makeProgram(calls).parseAsync(
    setArgs("-w", "p1", "--openai-api-key", KEY),
  );
  assert.deepEqual(calls, [{ project_id: "p1", api_key: KEY }]);
});

test("api-key set reads the key from stdin", async () => {
  const calls: any[] = [];
  await makeProgram(calls).parseAsync(setArgs("-w", "p1", "--stdin"));
  assert.deepEqual(calls, [{ project_id: "p1", api_key: KEY }]);
});

test("api-key set reads the key from a private file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-key-"));
  try {
    const file = join(dir, "key");
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    const calls: any[] = [];
    await makeProgram(calls).parseAsync(
      setArgs("--scope", "account", "--key-file", file),
    );
    assert.deepEqual(calls, [{ api_key: KEY }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api-key set never uses the root --api-key as the OpenAI key", async () => {
  const calls: any[] = [];
  await assert.rejects(
    makeProgram(calls).parseAsync(setArgs("-w", "p1", "--api-key", KEY)),
    /exactly one of --openai-api-key, --key-file or --stdin/,
  );
  assert.deepEqual(calls, []);
});

test("api-key set rejects two key sources", async () => {
  const calls: any[] = [];
  await assert.rejects(
    makeProgram(calls).parseAsync(
      setArgs("-w", "p1", "--stdin", "--openai-api-key", KEY),
    ),
    /exactly one of/,
  );
  assert.deepEqual(calls, []);
});
