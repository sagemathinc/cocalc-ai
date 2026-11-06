/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  execFile as realExecFile,
  spawn as realSpawn,
} from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import {
  claudeInProjectScript,
  claudeInProjectStopScript,
  claudeProjectsKey,
  claudeSubscriptionRuntime,
  launchClaudeSubscriptionInProject,
  migrateClaudeSession,
  resetClaudeSubscriptionRuntimeCache,
} from "./claude-subscription-in-project";
import { createProjectCliTokenLease } from "../codex/codex-project";
import { startProviderRelaySession } from "../codex/site-funded-proxy";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { localPath } from "@cocalc/project-runner/run/filesystem";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return { ...actual, execFile: jest.fn(), spawn: jest.fn() };
});
jest.mock("@cocalc/lite/hub/api", () => ({ hubApi: {} }));
jest.mock("../codex/codex-project", () => ({
  createProjectCliTokenLease: jest.fn(),
  ensureProjectContainerRunning: jest.fn(async () => {}),
  applyProjectRuntimeCliEnv: jest.fn(),
  resolveProjectRuntimeApiUrl: () => "http://project-hub",
  pushPodmanEnv: (args: string[], env: Record<string, string>) => {
    const spawnEnv: Record<string, string> = {};
    for (const key in env) {
      if (/(KEY|TOKEN|SECRET|PASSWORD|PROXY)/i.test(key)) {
        args.push("-e", key);
        spawnEnv[key] = env[key];
      } else args.push("-e", `${key}=${env[key]}`);
    }
    return spawnEnv;
  },
}));
jest.mock("../codex/site-funded-proxy", () => ({
  startProviderRelaySession: jest.fn(),
}));
jest.mock("./claude-subscription-registry", () => ({
  getClaudeSubscriptionCredential: jest.fn(),
}));
jest.mock("./claude-subscription-token", () => ({
  claudeSubscriptionToken: (payload: string) =>
    payload.startsWith("token:") ? payload.slice(6) : undefined,
}));
jest.mock("@cocalc/project-runner/run/filesystem", () => ({
  localPath: jest.fn(),
}));
jest.mock("@cocalc/project-runner/run/podman", () => ({
  projectPoolPodmanLauncher: () => ({ command: "podman", argsPrefix: [] }),
}));

const run = promisify(
  jest.requireActual("node:child_process").execFile as typeof realExecFile,
);

const projectId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";
const otherCredentialId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const REAL_TOKEN = "sk-ant-oat01-REAL-subscription-token";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-in-project-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe("claudeProjectsKey", () => {
  it("matches Claude Code's directory naming", () => {
    expect(claudeProjectsKey("/home/user")).toBe("-home-user");
    expect(claudeProjectsKey("/tmp/k w.x_y/sub")).toBe("-tmp-k-w-x-y-sub");
    expect(claudeProjectsKey("/workspace")).toBe("-workspace");
  });
});

describe("migrateClaudeSession", () => {
  const old = (cred: string) =>
    join(
      root,
      ".local/share/cocalc/claude-sessions",
      accountId,
      cred,
      "-workspace",
    );
  const target = () => join(root, ".claude/projects/-home-user");

  it("copies a controller session and its directory into ~/.claude", async () => {
    await mkdir(join(old(credentialId), sessionId, "subagents"), {
      recursive: true,
    });
    await writeFile(join(old(credentialId), `${sessionId}.jsonl`), "line\n");
    await writeFile(
      join(old(credentialId), sessionId, "subagents", "a.jsonl"),
      "sub\n",
    );
    const opts = {
      projectHome: root,
      accountId,
      sessionId,
      cwd: "/home/user",
    };
    expect(await migrateClaudeSession(opts)).toBe("migrated");
    expect(await readFile(join(target(), `${sessionId}.jsonl`), "utf8")).toBe(
      "line\n",
    );
    expect(
      await readFile(join(target(), sessionId, "subagents", "a.jsonl"), "utf8"),
    ).toBe("sub\n");
    // Once there, it is Claude Code's: never copied over again.
    await writeFile(join(old(credentialId), `${sessionId}.jsonl`), "older\n");
    expect(await migrateClaudeSession(opts)).toBe("present");
    expect(await readFile(join(target(), `${sessionId}.jsonl`), "utf8")).toBe(
      "line\n",
    );
  });

  it("reports a session it cannot find", async () => {
    expect(
      await migrateClaudeSession({
        projectHome: root,
        accountId,
        sessionId,
        cwd: "/home/user",
      }),
    ).toBe("missing");
  });

  it("refuses a session found under two subscriptions", async () => {
    for (const cred of [credentialId, otherCredentialId]) {
      await mkdir(old(cred), { recursive: true });
      await writeFile(join(old(cred), `${sessionId}.jsonl`), cred);
    }
    await expect(
      migrateClaudeSession({
        projectHome: root,
        accountId,
        sessionId,
        cwd: "/home/user",
      }),
    ).rejects.toThrow(/Ambiguous Claude transcript/);
  });

  it("does not follow a symlinked target", async () => {
    await mkdir(old(credentialId), { recursive: true });
    await writeFile(join(old(credentialId), `${sessionId}.jsonl`), "line\n");
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(root, ".claude"));
    await symlink(elsewhere, join(root, ".claude/projects"));
    await expect(
      migrateClaudeSession({
        projectHome: root,
        accountId,
        sessionId,
        cwd: "/home/user",
      }),
    ).rejects.toThrow();
    await expect(
      lstat(join(elsewhere, "-home-user", `${sessionId}.jsonl`)),
    ).rejects.toThrow();
  });

  it("rejects ids that are not UUIDs", async () => {
    await expect(
      migrateClaudeSession({
        projectHome: root,
        accountId,
        sessionId: "../x",
        cwd: "/home/user",
      }),
    ).rejects.toThrow(/Invalid/);
  });
});

describe("claudeSubscriptionRuntime", () => {
  beforeEach(() => resetClaudeSubscriptionRuntimeCache());

  it("is the controller unless the site chose the project", async () => {
    expect(
      await claudeSubscriptionRuntime(async () => ({
        claudeSubscriptionRuntime: "project",
      })),
    ).toBe("project");
    resetClaudeSubscriptionRuntimeCache();
    expect(await claudeSubscriptionRuntime(async () => ({}))).toBe(
      "controller",
    );
    resetClaudeSubscriptionRuntimeCache();
    expect(
      await claudeSubscriptionRuntime(async () => {
        throw Error("hub down");
      }),
    ).toBe("controller");
  });

  it("caches the setting for a minute", async () => {
    const get = jest.fn(async () => ({ claudeSubscriptionRuntime: "project" }));
    expect(await claudeSubscriptionRuntime(get, 1_000)).toBe("project");
    expect(await claudeSubscriptionRuntime(get, 30_000)).toBe("project");
    expect(get).toHaveBeenCalledTimes(1);
    await claudeSubscriptionRuntime(get, 62_000);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("in-project scripts", () => {
  // The start script up to the adapter: the skill link and the pid file.
  const prelude = (pidFile: string) =>
    claudeInProjectScript(pidFile).replace(/\nexec [^\n]*$/, "\nexit 0");

  it("links the CoCalc skill, replacing only an empty leftover directory", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".claude/skills/cocalc"), { recursive: true });
    const pid = join(root, "pid");
    await run("/bin/sh", ["-c", prelude(pid)], {
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect(await readlink(join(home, ".claude/skills/cocalc"))).toBe(
      "/opt/cocalc/project-bundle/skills/cocalc",
    );
    expect((await readFile(pid, "utf8")).trim()).toMatch(/^\d+ \d+$/);
    // Running again keeps the link.
    await run("/bin/sh", ["-c", prelude(pid)], {
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect(await readlink(join(home, ".claude/skills/cocalc"))).toBe(
      "/opt/cocalc/project-bundle/skills/cocalc",
    );
  });

  it("keeps the project's own cocalc skill", async () => {
    const home = join(root, "home");
    const own = join(home, ".claude/skills/cocalc");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "mine");
    await run("/bin/sh", ["-c", prelude(join(root, "pid"))], {
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect((await lstat(own)).isDirectory()).toBe(true);
    expect(await readFile(join(own, "SKILL.md"), "utf8")).toBe("mine");
  });

  it("does not let a project API key reach Claude Code", () => {
    expect(claudeInProjectScript("/tmp/p")).toContain(
      "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN",
    );
  });

  const startTimeFn = claudeInProjectScript("/tmp/p")
    .split("\n")
    .find((line) => line.startsWith("st() "))!;
  const startOf = async (pid: number) => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  };

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("stop ends the adapter's whole process tree", async () => {
    const pidFile = join(root, "pid");
    const childFile = join(root, "child");
    // A stand-in adapter (its command line names claude-agent-acp) that
    // starts a grandchild ignoring TERM.
    const fake = jest.requireActual("node:child_process")
      .spawn as typeof realSpawn;
    const adapter = fake(
      "/bin/sh",
      [
        "-c",
        `${startTimeFn}\necho "$$ $(st $$)" > ${pidFile}; exec ${process.execPath} -e 'const c=require("child_process").spawn("/bin/sh",["-c","trap \\"\\" TERM; sleep 60 & echo $! > ${childFile}; wait"],{stdio:"ignore"}); setInterval(()=>{},1000)' claude-agent-acp`,
      ],
      { stdio: "ignore" },
    );
    try {
      let grandchild = 0;
      for (let i = 0; i < 100 && !grandchild; i++) {
        await new Promise((r) => setTimeout(r, 50));
        grandchild = parseInt(
          await readFile(childFile, "utf8").catch(() => ""),
        );
      }
      expect(grandchild).toBeGreaterThan(0);
      const [adapterPid, adapterStart] = (await readFile(pidFile, "utf8"))
        .trim()
        .split(" ")
        .map(Number);
      expect(adapterStart).toBeGreaterThan(0);
      expect(alive(adapterPid)).toBe(true);
      await run("/bin/sh", ["-c", claudeInProjectStopScript(pidFile)]);
      await new Promise((r) => setTimeout(r, 200));
      expect(alive(grandchild)).toBe(false);
      expect(adapter.exitCode !== null || adapter.signalCode !== null).toBe(
        true,
      );
    } finally {
      adapter.kill("SIGKILL");
    }
  }, 20_000);

  it("stop never signals a pid whose start time changed (pid reuse)", async () => {
    const fake = jest.requireActual("node:child_process")
      .spawn as typeof realSpawn;
    // A comm with spaces and parentheses, to exercise the stat parsing.
    const odd = join(root, "x) (y z");
    await copyFile("/bin/sh", odd);
    await chmod(odd, 0o755);
    const other = fake(odd, ["-c", "while :; do sleep 1; done"], {
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const helpers = claudeInProjectStopScript("/nonexistent")
        .split("\n")
        .filter((line) => /^(st|signal)\(\) /.test(line))
        .join("\n");
      expect(helpers.split("\n")).toHaveLength(2);
      const stat = await readFile(`/proc/${other.pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const { stdout } = await run("/bin/sh", [
        "-c",
        `${helpers}\nst ${other.pid}`,
      ]);
      expect(stdout.trim()).toBe(start);
      // Recorded with another start time: that pid is now someone else.
      await run("/bin/sh", [
        "-c",
        `${helpers}\nprocs="${other.pid}:${Number(start) + 1}"\nsignal KILL`,
      ]);
      await new Promise((r) => setTimeout(r, 100));
      expect(alive(other.pid!)).toBe(true);
      // The same process: signaled.
      await run("/bin/sh", [
        "-c",
        `${helpers}\nprocs="${other.pid}:${start}"\nsignal KILL`,
      ]);
      await new Promise((r) => setTimeout(r, 100));
      expect(other.exitCode !== null || other.signalCode !== null).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("stop leaves the adapter's pid alone when its start time is not the recorded one", async () => {
    // The recorded adapter exited and its pid now belongs to another process
    // (here: one whose command line would even pass the adapter check).
    const fake = jest.requireActual("node:child_process")
      .spawn as typeof realSpawn;
    const other = fake(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "claude-agent-acp"],
      { stdio: "ignore" },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      const pidFile = join(root, "pid");
      const start = Number(await startOf(other.pid!));
      await writeFile(pidFile, `${other.pid} ${start - 1}\n`);
      await run("/bin/sh", ["-c", claudeInProjectStopScript(pidFile)]);
      expect(alive(other.pid!)).toBe(true);
      // With its own identity it is the adapter, and is stopped.
      await writeFile(pidFile, `${other.pid} ${start}\n`);
      await run("/bin/sh", ["-c", claudeInProjectStopScript(pidFile)]);
      await new Promise((r) => setTimeout(r, 100));
      expect(other.exitCode !== null || other.signalCode !== null).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
  }, 20_000);

  it("stop leaves a process that is not the adapter alone", async () => {
    const fake = jest.requireActual("node:child_process")
      .spawn as typeof realSpawn;
    const other = fake("sleep", ["30"], { stdio: "ignore" });
    try {
      const pidFile = join(root, "pid");
      await writeFile(pidFile, `${other.pid} ${await startOf(other.pid!)}\n`);
      await run("/bin/sh", ["-c", claudeInProjectStopScript(pidFile)]);
      expect(alive(other.pid!)).toBe(true);
      await expect(lstat(pidFile)).rejects.toThrow();
    } finally {
      other.kill("SIGKILL");
    }
  });
});

describe("launchClaudeSubscriptionInProject", () => {
  const binding = {
    projectId,
    accountId,
    profile: {
      version: 2,
      kind: "acp",
      executionPolicy: "full-access",
      credentialMode: "project-managed",
      id: "claude-code",
      revision:
        require("@cocalc/util/ai/qualified-harnesses").getQualifiedHarnessCandidate(
          "claude-code",
        ).package.version,
      cwd: "/home/user/work",
    },
    credential: {
      mode: "account-subscription",
      provider: "anthropic",
      credentialId,
    },
  } as any;
  const conversation = { path: "a.chat", threadId: "thread-1" };

  let relay: { baseUrl: string; token: string; close: jest.Mock };
  let lease: any;
  let child: any;

  beforeEach(() => {
    (localPath as jest.Mock).mockResolvedValue({
      home: root,
      scratch: join(root, "scratch"),
    });
    (getClaudeSubscriptionCredential as jest.Mock).mockResolvedValue({
      payload: `token:${REAL_TOKEN}`,
    });
    relay = {
      baseUrl: "http://host.containers.internal:9301",
      token: "sk-ant-oat01-cocalc-RELAY",
      close: jest.fn(),
    };
    (startProviderRelaySession as jest.Mock).mockResolvedValue(relay);
    lease = {
      containerPath: "/tmp/.cocalc-agent-x/token",
      close: jest.fn(async () => {}),
      beginConnectorTurn: jest.fn(),
      endConnectorTurn: jest.fn(),
      applyCliConnectorEnv: jest.fn(),
    };
    (createProjectCliTokenLease as jest.Mock).mockResolvedValue(lease);
    (spawn as unknown as jest.Mock).mockImplementation(() => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn(() => child.emit("close"));
      return child;
    });
    (execFile as unknown as jest.Mock).mockImplementation(
      (_cmd, _args, _opts, cb) => cb(null, "", ""),
    );
  });

  it("execs the adapter in the project with only a relay token", async () => {
    const proc = await launchClaudeSubscriptionInProject(binding, conversation);
    expect(proc.sessionPolicy).toBe("default");
    expect(proc.subscriptionAuth).toBe("oauth-token");
    const [command, args, options] = (spawn as unknown as jest.Mock).mock
      .calls[0];
    expect(command).toBe("podman");
    expect(args.slice(0, 6)).toEqual([
      "exec",
      "-i",
      "-u",
      "2001:2001",
      "--workdir",
      "/home/user/work",
    ]);
    expect(args).toContain(`project-${projectId}`);
    expect(args.at(-1)).toContain("claude-agent-acp/dist/index.js");
    // Credentials go to podman by name only, never in argv.
    expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(args.join(" ")).not.toContain(relay.token);
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(relay.token);
    expect(args).toContain(`ANTHROPIC_BASE_URL=${relay.baseUrl}`);
    expect(args).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    expect(args).toContain("ENABLE_CLAUDEAI_MCP_SERVERS=false");
    // The subscription token goes nowhere near the project.
    expect(JSON.stringify([args, options])).not.toContain(REAL_TOKEN);

    // The relay adds it on the host side, as a bearer token.
    const policy = (startProviderRelaySession as jest.Mock).mock.calls[0][0];
    expect(policy).toMatchObject({
      upstream: "https://api.anthropic.com",
      allowedPathPrefix: "/v1/",
      credentialHeader: "authorization",
      tokenPrefix: "sk-ant-oat01-cocalc-",
    });
    expect(await policy.credentialValue()).toBe(`Bearer ${REAL_TOKEN}`);

    await proc.stop();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect((execFile as unknown as jest.Mock).mock.calls[0][1]).toContain(
      `project-${projectId}`,
    );
    expect(relay.close).toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalled();
  });

  it("revalidates the subscription token at most every minute", async () => {
    await launchClaudeSubscriptionInProject(binding, conversation);
    const policy = (startProviderRelaySession as jest.Mock).mock.calls[0][0];
    const now = Date.now();
    const spy = jest.spyOn(Date, "now");
    try {
      (getClaudeSubscriptionCredential as jest.Mock).mockRejectedValue(
        Error("Claude subscription credential is unavailable or revoked"),
      );
      spy.mockReturnValue(now + 10_000);
      expect(await policy.credentialValue()).toBe(`Bearer ${REAL_TOKEN}`);
      spy.mockReturnValue(now + 61_000);
      await expect(policy.credentialValue()).rejects.toThrow(/revoked/);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes the relay when the adapter exits", async () => {
    await launchClaudeSubscriptionInProject(binding, conversation);
    child.emit("close");
    await new Promise((r) => setImmediate(r));
    expect(relay.close).toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalled();
  });

  it("refuses an old home-snapshot sign-in before starting anything", async () => {
    (getClaudeSubscriptionCredential as jest.Mock).mockResolvedValue({
      payload: JSON.stringify({ version: 1, files: [] }),
    });
    await expect(
      launchClaudeSubscriptionInProject(binding, conversation),
    ).rejects.toThrow(/Reconnect it/);
    expect(startProviderRelaySession).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("closes the relay if the CLI lease fails", async () => {
    (createProjectCliTokenLease as jest.Mock).mockResolvedValue(undefined);
    await expect(
      launchClaudeSubscriptionInProject(binding, conversation),
    ).rejects.toThrow(/CLI credentials/);
    expect(relay.close).toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects bindings that are not a Claude subscription", async () => {
    await expect(
      launchClaudeSubscriptionInProject(
        {
          ...binding,
          credential: { mode: "account-api-key", provider: "anthropic" },
        },
        conversation,
      ),
    ).rejects.toThrow(/Unsupported/);
  });
});
