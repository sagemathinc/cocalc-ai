import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerBrowserCommand } from "./browser";
import { resolveBrowserSessionDaemonScriptPath } from "./browser/register-session-commands";

const PROJECT_A = "00000000-1000-4000-8000-0000000000aa";
const PROJECT_B = "00000000-1000-4000-8000-0000000000bb";
const ORIGINAL_COCALC_CLI_AGENT_MODE = process.env.COCALC_CLI_AGENT_MODE;
const ORIGINAL_COCALC_AGENT_MODE = process.env.COCALC_AGENT_MODE;
const ORIGINAL_COCALC_PROJECT_ID = process.env.COCALC_PROJECT_ID;

function makeProgram({
  openFiles,
  listBrowserSessions,
  getWorkspaceSelection,
  getAutomationPolicyInfo,
  getExecApiDeclaration,
  listRuntimeEvents,
  globals,
}: {
  openFiles: { project_id: string; title?: string; path: string }[];
  listBrowserSessions?: () => Promise<any[]>;
  getWorkspaceSelection?: (opts: { project_id: string }) => Promise<any>;
  getAutomationPolicyInfo?: () => Promise<any>;
  getExecApiDeclaration?: () => Promise<string>;
  listRuntimeEvents?: (opts?: any) => Promise<any>;
  globals?: Record<string, unknown>;
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
        globals: globals ?? {},
        accountId: "00000000-1000-4000-8000-000000000001",
        timeoutMs: globals?.timeout === "1s" ? 1_000 : 30_000,
        apiBaseUrl: "http://localhost:7003",
        remote: { client: {} },
        hub: {
          system: {
            listBrowserSessions:
              listBrowserSessions ??
              (async () => [
                {
                  browser_id: "browser-1",
                  active_project_id: PROJECT_A,
                  open_projects: [{ project_id: PROJECT_A }],
                  stale: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  url: `http://localhost:7003/projects/${PROJECT_A}/files`,
                },
              ]),
            removeBrowserSession: async () => ({ removed: false }),
            issueBrowserSignInCookie: async () => ({}),
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
      throw new Error("resolveProjectConatClient should not be called");
    },
    createBrowserSessionClient: () =>
      ({
        listOpenFiles: async () => openFiles,
        getWorkspaceSelection:
          getWorkspaceSelection ??
          (async () => {
            throw new Error("getWorkspaceSelection should not be called");
          }),
        getAutomationPolicyInfo:
          getAutomationPolicyInfo ??
          (async () => ({
            raw_exec_policy: "enabled",
            raw_exec_admin: false,
            max_active_exec_ops: 2,
            max_active_actions: 8,
            max_async_exec_ops: 256,
            max_exec_code_length: 100000,
            max_sandbox_actions: 512,
          })),
        getExecApiDeclaration:
          getExecApiDeclaration ??
          (async () =>
            "export type BrowserExecApi = { listOpenFiles: () => unknown[]; };"),
        listRuntimeEvents:
          listRuntimeEvents ??
          (async () => ({
            events: [],
            next_seq: 0,
            dropped: 0,
            total_buffered: 0,
          })),
      }) as any,
  } as any);
  return { program, results };
}

test("browser files filters open files by --project-id", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
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
        kind: "file",
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

test("browser files reports an open project tab when no files are open", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  const { program, results } = makeProgram({
    openFiles: [],
    listBrowserSessions: async () => [
      {
        browser_id: "browser-1",
        active_project_id: PROJECT_A,
        open_projects: [{ project_id: PROJECT_A, title: "Project A" }],
        stale: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        url: `http://localhost:7003/projects/${PROJECT_A}/files`,
      },
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
        kind: "project",
        project_id: PROJECT_A,
        title: "Project A",
        target_api_url: "http://localhost:7003",
        target_browser_id: "browser-1",
        target_session_url: `http://localhost:7003/projects/${PROJECT_A}/files`,
        target_project_id: PROJECT_A,
      },
    ],
  ]);
});

test("browser files keeps project-only tabs alongside file rows", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  delete process.env.COCALC_PROJECT_ID;
  const { program, results } = makeProgram({
    openFiles: [{ project_id: PROJECT_A, title: "A", path: "/home/user/a.md" }],
    listBrowserSessions: async () => [
      {
        browser_id: "browser-1",
        active_project_id: PROJECT_A,
        open_projects: [
          { project_id: PROJECT_A, title: "Project A" },
          { project_id: PROJECT_B, title: "Project B" },
        ],
        stale: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        url: `http://localhost:7003/projects/${PROJECT_A}/files`,
      },
    ],
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "files",
    "--browser",
    "browser-1",
  ]);

  assert.deepEqual(results, [
    [
      {
        browser_id: "browser-1",
        kind: "project",
        project_id: PROJECT_B,
        title: "Project B",
        target_api_url: "http://localhost:7003",
        target_browser_id: "browser-1",
        target_session_url: `http://localhost:7003/projects/${PROJECT_A}/files`,
        target_project_id: PROJECT_B,
      },
      {
        browser_id: "browser-1",
        kind: "file",
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

test("browser files does not implicitly filter rows by COCALC_PROJECT_ID", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  process.env.COCALC_PROJECT_ID = PROJECT_A;
  const { program, results } = makeProgram({
    openFiles: [{ project_id: PROJECT_A, title: "A", path: "/home/user/a.md" }],
    listBrowserSessions: async () => [
      {
        browser_id: "browser-1",
        active_project_id: PROJECT_B,
        open_projects: [
          { project_id: PROJECT_A, title: "Project A" },
          { project_id: PROJECT_B, title: "Project B" },
        ],
        stale: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        url: `http://localhost:7003/projects/${PROJECT_B}/files`,
      },
    ],
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "files",
    "--browser",
    "browser-1",
  ]);

  assert.deepEqual(results, [
    [
      {
        browser_id: "browser-1",
        kind: "project",
        project_id: PROJECT_B,
        title: "Project B",
        target_api_url: "http://localhost:7003",
        target_browser_id: "browser-1",
        target_session_url: `http://localhost:7003/projects/${PROJECT_B}/files`,
        target_project_id: PROJECT_B,
      },
      {
        browser_id: "browser-1",
        kind: "file",
        project_id: PROJECT_A,
        title: "A",
        path: "/home/user/a.md",
        target_api_url: "http://localhost:7003",
        target_browser_id: "browser-1",
        target_session_url: `http://localhost:7003/projects/${PROJECT_B}/files`,
        target_project_id: PROJECT_A,
      },
    ],
  ]);
});

test("browser tabs is an alias for browser files", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
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
  assert.equal((results[0] as { kind: string }[])[0]?.kind, "file");
});

test("browser exec-api reports the QuickJS sandbox API when raw exec is disabled", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  const { program, results } = makeProgram({
    openFiles: [],
    getAutomationPolicyInfo: async () => ({
      raw_exec_policy: "disabled",
      raw_exec_admin: true,
      max_active_exec_ops: 2,
      max_active_actions: 8,
      max_async_exec_ops: 256,
      max_exec_code_length: 100000,
      max_sandbox_actions: 512,
    }),
    getExecApiDeclaration: async () =>
      "export type BrowserExecApi = { listOpenFiles: () => unknown[]; };",
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "exec-api",
    "--browser",
    "browser-1",
  ]);

  const output = results[0] as string;
  assert.match(output, /raw_exec_policy=disabled/);
  assert.match(output, /QuickJS sandbox mode/);
  assert.match(output, /waitForSelector/);
  assert.match(output, /BrowserExecActionResult;/);
  assert.doesNotMatch(output, /listOpenFiles/);
  assert.doesNotMatch(output, /Promise<BrowserExecActionResult>/);
});

test("browser exec-api reports the raw API when raw exec is allowed", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  const { program, results } = makeProgram({
    openFiles: [],
    getAutomationPolicyInfo: async () => ({
      raw_exec_policy: "enabled",
      raw_exec_admin: false,
      max_active_exec_ops: 2,
      max_active_actions: 8,
      max_async_exec_ops: 256,
      max_exec_code_length: 100000,
      max_sandbox_actions: 512,
    }),
    getExecApiDeclaration: async () =>
      "export type BrowserExecApi = { listOpenFiles: () => unknown[]; };",
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "exec-api",
    "--browser",
    "browser-1",
  ]);

  const output = results[0] as string;
  assert.match(output, /raw_exec_policy=enabled/);
  assert.match(output, /listOpenFiles/);
  assert.doesNotMatch(output, /QuickJS sandbox mode/);
});

test("browser logs tail --follow respects timeout while waiting for events", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  const started = Date.now();
  const { program, results } = makeProgram({
    openFiles: [],
    listRuntimeEvents: async () =>
      new Promise(() => {
        // Simulate a browser-session RPC that is waiting for new log events.
      }),
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "logs",
    "tail",
    "--browser",
    "browser-1",
    "--follow",
    "--timeout",
    "1s",
    "--poll-ms",
    "100ms",
  ]);

  assert.ok(Date.now() - started < 2_500);
  assert.deepEqual(results[0], {
    browser_id: "browser-1",
    printed: 0,
    next_seq: 0,
    dropped: 0,
    total_buffered: 0,
    target_api_url: "http://localhost:7003",
    target_browser_id: "browser-1",
    target_session_url: "",
  });
});

test("browser logs tail --follow inherits explicit root timeout", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  const started = Date.now();
  const { program, results } = makeProgram({
    openFiles: [],
    globals: { timeout: "1s" },
    listRuntimeEvents: async () =>
      new Promise(() => {
        // Simulate a browser-session RPC that is waiting for new log events.
      }),
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "logs",
    "tail",
    "--browser",
    "browser-1",
    "--follow",
    "--poll-ms",
    "100ms",
  ]);

  assert.ok(Date.now() - started < 2_500);
  assert.equal((results[0] as any).printed, 0);
});

test("browser workspace-state falls back to a partial summary on transient browser auth failures", async () => {
  delete process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_AGENT_MODE;
  delete process.env.COCALC_PROJECT_ID;
  const { program, results } = makeProgram({
    openFiles: [{ project_id: PROJECT_A, title: "A", path: "/home/user/a.md" }],
    getWorkspaceSelection: async () => {
      throw new Error(
        "failed to sign in - Error: too many authentication failures from ip:1.2.3.4; retry in about 51s",
      );
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "workspace-state",
    "--browser",
    "browser-1",
  ]);

  assert.deepEqual(results, [
    {
      browser_id: "browser-1",
      project_id: PROJECT_A,
      selection: { kind: "all" },
      selection_label: "All tabs",
      selected_workspace: null,
      open_file_count: 1,
      visible_file_count: 1,
      unscoped_open_file_count: 1,
      workspaces: [],
      open_files: [
        {
          title: "A",
          path: "/home/user/a.md",
          kind: "unscoped",
          workspace_id: null,
          workspace_title: null,
          in_selected_scope: true,
        },
      ],
      workspace_state_partial: true,
      workspace_state_warning:
        "workspace selection unavailable while project-host auth is retrying; showing partial open-file summary (retry in about 51s)",
      target_api_url: "http://localhost:7003",
      target_browser_id: "browser-1",
      target_session_url: `http://localhost:7003/projects/${PROJECT_A}/files`,
      target_project_id: PROJECT_A,
    },
  ]);
});

test("browser session list fails fast with a clear message under agent auth", async () => {
  process.env.COCALC_CLI_AGENT_MODE = "1";
  delete process.env.COCALC_AGENT_MODE;
  const { program } = makeProgram({
    openFiles: [],
    listBrowserSessions: async () => {
      throw new Error("listBrowserSessions should not be called");
    },
  });

  await assert.rejects(
    () => program.parseAsync(["node", "test", "browser", "session", "list"]),
    /browser session list is unavailable under agent auth/,
  );
});

test("browser session use accepts an exact browser id under agent auth", async () => {
  process.env.COCALC_CLI_AGENT_MODE = "1";
  delete process.env.COCALC_AGENT_MODE;
  const { program, results } = makeProgram({
    openFiles: [],
    listBrowserSessions: async () => {
      throw new Error("listBrowserSessions should not be called");
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "browser",
    "session",
    "use",
    "wZbV6ZDCkk",
  ]);

  assert.deepEqual(results, [
    {
      profile: "default",
      browser_id: "wZbV6ZDCkk",
      stale: false,
      api_scope: "http://localhost:7003",
    },
  ]);
});

test("browser session spawn fails fast with a clear message under agent auth", async () => {
  process.env.COCALC_CLI_AGENT_MODE = "1";
  delete process.env.COCALC_AGENT_MODE;
  const { program } = makeProgram({
    openFiles: [],
  });

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "browser",
        "session",
        "spawn",
        "--project-id",
        PROJECT_A,
      ]),
    /browser session spawn is unavailable under agent auth/,
  );
});

test("resolveBrowserSessionDaemonScriptPath falls back to COCALC_CLI_BIN dist", () => {
  const bundledPath = "/opt/core/browser-session-playwright-daemon.js";
  const repoPath = resolvePath(
    "/home/user/cocalc-ai/src/packages/cli/dist/bin",
    "..",
    "core",
    "browser-session-playwright-daemon.js",
  );
  const resolved = resolveBrowserSessionDaemonScriptPath({
    moduleDir: "/opt/cocalc/bin/commands/browser",
    cliBinPath: "/home/user/cocalc-ai/src/packages/cli/dist/bin/cocalc.js",
    argvPath: "/opt/cocalc/bin2/cocalc-cli.js",
    resolvePath,
    existsSync: (path) => path === repoPath,
  });
  assert.equal(resolved, repoPath);
  assert.notEqual(resolved, bundledPath);
});

test("resolveBrowserSessionDaemonScriptPath falls back to parent core next to wrapper argvPath", () => {
  const wrapperSiblingCore = resolvePath(
    "/opt/cocalc/bin2",
    "..",
    "core",
    "browser-session-playwright-daemon.js",
  );
  const resolved = resolveBrowserSessionDaemonScriptPath({
    moduleDir: "/missing",
    cliBinPath: "",
    argvPath: "/opt/cocalc/bin2/cocalc-cli.js",
    resolvePath,
    existsSync: (path) => path === wrapperSiblingCore,
  });
  assert.equal(resolved, wrapperSiblingCore);
});

test("resolveBrowserSessionDaemonScriptPath prefers bundled daemon when present", () => {
  const bundledPath = resolvePath(
    "/opt/cocalc/bin/commands/browser",
    "..",
    "..",
    "core",
    "browser-session-playwright-daemon.js",
  );
  const resolved = resolveBrowserSessionDaemonScriptPath({
    moduleDir: "/opt/cocalc/bin/commands/browser",
    cliBinPath: "/home/user/cocalc-ai/src/packages/cli/dist/bin/cocalc.js",
    argvPath: "/opt/cocalc/bin2/cocalc-cli.js",
    resolvePath,
    existsSync: (path) => path === bundledPath,
  });
  assert.equal(resolved, bundledPath);
});

test.after(() => {
  if (ORIGINAL_COCALC_CLI_AGENT_MODE == null) {
    delete process.env.COCALC_CLI_AGENT_MODE;
  } else {
    process.env.COCALC_CLI_AGENT_MODE = ORIGINAL_COCALC_CLI_AGENT_MODE;
  }
  if (ORIGINAL_COCALC_AGENT_MODE == null) {
    delete process.env.COCALC_AGENT_MODE;
  } else {
    process.env.COCALC_AGENT_MODE = ORIGINAL_COCALC_AGENT_MODE;
  }
  if (ORIGINAL_COCALC_PROJECT_ID == null) {
    delete process.env.COCALC_PROJECT_ID;
  } else {
    process.env.COCALC_PROJECT_ID = ORIGINAL_COCALC_PROJECT_ID;
  }
});
