import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerBrowserCommand } from "./browser";

const PROJECT_A = "00000000-1000-4000-8000-0000000000aa";
const PROJECT_B = "00000000-1000-4000-8000-0000000000bb";

function makeProgram({
  openFiles,
}: {
  openFiles: { project_id: string; title?: string; path: string }[];
}): { program: Command; results: unknown[] } {
  const results: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerBrowserCommand(program, {
    withContext: async (_command, _label, fn) => {
      const result = await fn({
        globals: {},
        accountId: "00000000-1000-4000-8000-000000000001",
        timeoutMs: 30_000,
        apiBaseUrl: "http://localhost:7003",
        remote: { client: {} },
        hub: {
          system: {
            listBrowserSessions: async () => [
              {
                browser_id: "browser-1",
                active_project_id: PROJECT_A,
                open_projects: [{ project_id: PROJECT_A }],
                stale: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                url: `http://localhost:7003/projects/${PROJECT_A}/files`,
              },
            ],
            removeBrowserSession: async () => ({ removed: false }),
            issueBrowserSignInCookie: async () => ({}),
            generateUserAuthToken: async () => "token",
          },
        },
      } as any);
      results.push(result);
    },
    authConfigPath: () => "/tmp/cocalc-browser-command-test.json",
    loadAuthConfig: () => ({ profiles: { default: {} } }),
    saveAuthConfig: () => undefined,
    selectedProfileName: () => "default",
    globalsFrom: () => ({}),
    resolveProject: async (_ctx, project) => ({ project_id: project }),
    resolveProjectConatClient: async () => {
      throw new Error("not used");
    },
    createBrowserSessionClient: () =>
      ({
        listOpenFiles: async () => openFiles,
      }) as any,
  } as any);
  return { program, results };
}

async function withoutAgentMode(fn: () => Promise<void>): Promise<void> {
  const prevCliAgentMode = process.env.COCALC_CLI_AGENT_MODE;
  const prevAgentMode = process.env.COCALC_AGENT_MODE;
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  try {
    await fn();
  } finally {
    if (prevCliAgentMode == null) {
      delete process.env.COCALC_CLI_AGENT_MODE;
    } else {
      process.env.COCALC_CLI_AGENT_MODE = prevCliAgentMode;
    }
    if (prevAgentMode == null) {
      delete process.env.COCALC_AGENT_MODE;
    } else {
      process.env.COCALC_AGENT_MODE = prevAgentMode;
    }
  }
}

test("browser files filters open files by --project-id", async () => {
  await withoutAgentMode(async () => {
    const { program, results } = makeProgram({
      openFiles: [
        { project_id: PROJECT_A, title: "A", path: "/home/user/a.md" },
        { project_id: PROJECT_B, title: "B", path: "/home/user/b.md" },
      ],
    });

    await program.parseAsync([
      "node",
      "test",
      "browser",
      "files",
      "--browser",
      "browser-1",
      "--project-id",
      PROJECT_A,
    ]);

    assert.deepEqual(results, [
      [
        {
          browser_id: "browser-1",
          project_id: PROJECT_A,
          title: "A",
          path: "/home/user/a.md",
          target_api_url: "http://localhost:7003",
          target_browser_id: "browser-1",
          target_session_url: `http://localhost:7003/projects/${PROJECT_A}/files`,
          target_project_id: PROJECT_A,
        },
      ],
    ]);
  });
});

test("browser tabs is an alias for browser files", async () => {
  const { program, results } = makeProgram({
    openFiles: [{ project_id: PROJECT_A, title: "A", path: "/home/user/a.md" }],
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "tabs",
    "--browser",
    "browser-1",
    "--project-id",
    PROJECT_A,
  ]);

  assert.equal((results[0] as unknown[]).length, 1);
  assert.equal((results[0] as { path: string }[])[0]?.path, "/home/user/a.md");
});
