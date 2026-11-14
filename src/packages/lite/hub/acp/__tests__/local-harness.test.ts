import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_INSTALL_HELP,
  claudeVersionWarning,
  installLiteHarnessLauncher,
  launchLocalHarness,
  localHarnessEnv,
  resolveClaudeAdapterEntry,
  resolveClaudeExecutable,
  resolveLocalHarnessCommand,
} from "../local-harness";
import { getHarnessLauncher, setHarnessLauncher } from "../harness-runtime";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

const claudeProfile = {
  version: 2 as const,
  kind: "acp" as const,
  id: "claude-code",
  revision: CLAUDE_CODE_QUALIFICATION.package.version,
  cwd: "/home/user",
  executionPolicy: "full-access" as const,
  credentialMode: "project-managed" as const,
};

afterEach(() => setHarnessLauncher());

describe("resolveClaudeAdapterEntry", () => {
  it("prefers COCALC_CLAUDE_AGENT_ACP and requires it to exist", () => {
    expect(
      resolveClaudeAdapterEntry({
        env: { COCALC_CLAUDE_AGENT_ACP: "/x/index.js" },
        exists: (f) => f === "/x/index.js",
      }),
    ).toBe("/x/index.js");
    expect(() =>
      resolveClaudeAdapterEntry({
        env: { COCALC_CLAUDE_AGENT_ACP: "/x/index.js" },
        exists: () => false,
      }),
    ).toThrow("does not exist");
  });

  it("finds the copy shipped next to the bundle", () => {
    const shipped =
      "/app/bundle/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    expect(
      resolveClaudeAdapterEntry({
        env: {},
        entryPoint: "/app/bundle/index.js",
        exists: (f) => f === shipped,
      }),
    ).toBe(shipped);
  });

  it("says the installation lacks the adapter", () => {
    expect(() =>
      resolveClaudeAdapterEntry({
        env: {},
        entryPoint: "/app/bundle/index.js",
        exists: () => false,
      }),
    ).toThrow("does not include the Claude Code adapter");
  });
});

describe("resolveClaudeExecutable", () => {
  it("uses COCALC_CLAUDE_BIN only if it exists", () => {
    expect(
      resolveClaudeExecutable({
        env: { COCALC_CLAUDE_BIN: "/c/claude", PATH: "/usr/bin" },
        isFile: (f) => f === "/c/claude",
      }),
    ).toBe("/c/claude");
    expect(
      resolveClaudeExecutable({
        env: { COCALC_CLAUDE_BIN: "/c/claude", PATH: "/usr/bin" },
        isFile: (f) => f === "/usr/bin/claude",
      }),
    ).toBeUndefined();
  });

  it("searches PATH, then the installers' locations", () => {
    expect(
      resolveClaudeExecutable({
        env: { PATH: "/a:/b" },
        platform: "linux",
        home: "/h",
        isFile: (f) => f === "/b/claude",
      }),
    ).toBe("/b/claude");
    expect(
      resolveClaudeExecutable({
        env: { PATH: "/a" },
        platform: "linux",
        home: "/h",
        isFile: (f) => f === "/h/.local/bin/claude",
      }),
    ).toBe("/h/.local/bin/claude");
    expect(
      resolveClaudeExecutable({
        env: { PATH: "C:\\bin" },
        platform: "win32",
        home: "C:\\Users\\u",
        isFile: (f) => f === "C:\\Users\\u\\.local\\bin\\claude.exe",
      }),
    ).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
    expect(
      resolveClaudeExecutable({
        env: { PATH: "/a" },
        platform: "linux",
        home: "/h",
        isFile: () => false,
      }),
    ).toBeUndefined();
  });
});

describe("claudeVersionWarning", () => {
  it("accepts the same major.minor at or after the pin", () => {
    expect(claudeVersionWarning("2.1.300 (Claude Code)", "2.1.300")).toBe(
      undefined,
    );
    expect(claudeVersionWarning("2.1.412 (Claude Code)", "2.1.300")).toBe(
      undefined,
    );
  });

  it("warns, without refusing, outside the range", () => {
    expect(claudeVersionWarning("2.1.200 (Claude Code)", "2.1.300")).toMatch(
      /version 2\.1\.200.*tested with 2\.1\.x from 2\.1\.300/,
    );
    expect(claudeVersionWarning("2.2.0", "2.1.300")).toMatch(/2\.2\.0/);
    expect(claudeVersionWarning("3.0.0", "2.1.300")).toMatch(/3\.0\.0/);
    expect(claudeVersionWarning(undefined, "2.1.300")).toMatch(
      /Could not determine/,
    );
    expect(claudeVersionWarning("2.1.0", undefined)).toBeUndefined();
  });
});

describe("resolveLocalHarnessCommand", () => {
  const deps = {
    env: {},
    adapterEntry: () => "/adapter/dist/index.js",
    claudeExecutable: () => "/bin/claude",
    claudeVersion: async () => "2.1.300 (Claude Code)",
  };

  it("runs the adapter with the user's claude and no auth guard", async () => {
    const command = await resolveLocalHarnessCommand(
      claudeProfile,
      "project-secret",
      deps,
    );
    expect(command.executable).toBe(process.execPath);
    expect(command.args).toEqual(["/adapter/dist/index.js"]);
    expect(command.args).not.toContain("--hide-claude-auth");
    expect(command.env.CLAUDE_CODE_EXECUTABLE).toBe("/bin/claude");
  });

  it("explains how to install Claude Code when it is missing", async () => {
    await expect(
      resolveLocalHarnessCommand(claudeProfile, "project-secret", {
        ...deps,
        claudeExecutable: () => undefined,
      }),
    ).rejects.toThrow(CLAUDE_INSTALL_HELP);
  });

  it("refuses CoCalc's account and site credentials", async () => {
    for (const mode of [
      "account-api-key",
      "account-subscription",
      "site-funded",
    ])
      await expect(
        resolveLocalHarnessCommand(claudeProfile, mode, deps),
      ).rejects.toThrow("this computer's own Claude Code sign-in");
  });

  it("runs a project-configured agent as configured", async () => {
    const command = await resolveLocalHarnessCommand(
      {
        version: 1,
        kind: "acp",
        id: "mine",
        revision: "1",
        executable: "/opt/agent",
        args: ["--acp"],
        cwd: "/home/user",
        executionPolicy: "full-access",
        credentialMode: "project-managed",
      },
      "project-managed",
      deps,
    );
    expect(command).toEqual({
      executable: "/opt/agent",
      args: ["--acp"],
      env: {},
    });
  });
});

describe("localHarnessEnv", () => {
  it("keeps the user's environment and sets this conversation's context", () => {
    const env = localHarnessEnv({
      base: {
        PATH: "/usr/bin",
        HOME: "/data/home",
        COCALC_ORIGINAL_HOME: "/home/u",
        ANTHROPIC_API_KEY: "kept",
        COCALC_AGENT_IDENTITY_FILE: "/other/identity",
        COCALC_CODEX_TURN_ID: "stale",
      },
      projectId: PROJECT,
      accountId: ACCOUNT,
      path: "a.chat",
      threadId: "t1",
      extra: { CLAUDE_CODE_EXECUTABLE: "/bin/claude" },
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "kept",
      CLAUDE_CODE_EXECUTABLE: "/bin/claude",
      COCALC_PROJECT_ID: PROJECT,
      COCALC_ACCOUNT_ID: ACCOUNT,
      COCALC_CODEX_CHAT_PATH: "a.chat",
      COCALC_CODEX_THREAD_ID: "t1",
      COCALC_CLI_AGENT_MODE: "1",
    });
    expect(env.COCALC_AGENT_IDENTITY_FILE).toBeUndefined();
    expect(env.COCALC_CODEX_TURN_ID).toBeUndefined();
  });
});

describe("installLiteHarnessLauncher", () => {
  it("installs the local launcher only where none is installed", () => {
    installLiteHarnessLauncher();
    expect(getHarnessLauncher()).toBe(launchLocalHarness);
    const hostLauncher = jest.fn();
    setHarnessLauncher(hostLauncher);
    installLiteHarnessLauncher();
    expect(getHarnessLauncher()).toBe(hostLauncher);
  });
});

describe("launchLocalHarness", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "local-harness-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const binding = (executable: string, args: string[] = []) => ({
    projectId: PROJECT,
    accountId: ACCOUNT,
    profile: {
      version: 1 as const,
      kind: "acp" as const,
      id: "test",
      revision: "1",
      executable,
      args,
      cwd: dir,
      executionPolicy: "full-access" as const,
      credentialMode: "project-managed" as const,
    },
    credential: {
      version: 1 as const,
      provider: "project" as const,
      mode: "project-managed" as const,
    },
  });

  it("speaks over the child's stdio in the working directory", async () => {
    const script = path.join(dir, "agent.sh");
    writeFileSync(
      script,
      '#!/bin/sh\necho "$PWD $COCALC_CODEX_THREAD_ID"\nread line\necho "got $line"\n',
    );
    chmodSync(script, 0o755);
    const proc = await launchLocalHarness(binding(script), {
      path: "a.chat",
      threadId: "t1",
    });
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.stdin.write("hello\n");
    await proc.closed;
    expect(out).toBe(`${dir} t1\ngot hello\n`);
  });

  it("stops the harness and what it started", async () => {
    const script = path.join(dir, "agent.sh");
    const marker = path.join(dir, "child.pid");
    // A background child in the same group, like a shell command the agent ran.
    writeFileSync(
      script,
      `#!/bin/sh\nsleep 300 &\necho $! > ${marker}\nwait\n`,
    );
    chmodSync(script, 0o755);
    const proc = await launchLocalHarness(binding(script), {
      path: "a.chat",
      threadId: "t1",
    });
    const { readFileSync, existsSync } = await import("node:fs");
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 20));
    const childPid = Number(readFileSync(marker, "utf8"));
    await proc.stop();
    await proc.closed;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("refuses a working directory that does not exist", async () => {
    const b = binding("/bin/true");
    b.profile.cwd = path.join(dir, "missing");
    await expect(
      launchLocalHarness(b, { path: "a.chat", threadId: "t1" }),
    ).rejects.toThrow("does not exist");
  });
});
