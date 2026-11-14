/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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
  MANAGED_POLICY_MESSAGE,
  claudeInProjectBackgroundWorkScript,
  claudeInProjectScript,
  claudeInProjectStopScript,
  claudeManagedPolicyCheck,
  superviseInProjectProcess,
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

  it("does not pass on settings-location overrides", () => {
    expect(claudeInProjectScript("/tmp/p")).toContain(
      "unset CLAUDE_CODE_MANAGED_SETTINGS_PATH CLAUDE_CODE_REMOTE_SETTINGS_PATH CLAUDE_CODE_MOCK_REMOTE_SETTINGS CLAUDE_CODE_MANAGED_CONFIG_PREFETCH",
    );
  });

  describe("refuses a Claude Code managed policy before the adapter starts", () => {
    // the start script up to the adapter, with the policy root in `root`
    const start = async (policy: string) => {
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      const pid = join(root, "pid");
      const script = claudeInProjectScript(pid, policy).replace(
        /\nexec [^\n]*$/,
        "\nexit 0",
      );
      const code = await run("/bin/sh", ["-c", script], {
        env: { HOME: home, PATH: process.env.PATH },
      }).then(
        () => 0,
        (error) => error.code,
      );
      const started = await lstat(pid).then(
        () => true,
        () => false,
      );
      return { code, started };
    };
    const policy = () => join(root, "etc-claude-code");

    it("starts when there is none", async () => {
      expect(await start(policy())).toEqual({ code: 0, started: true });
    });

    it("refuses a policy created after the launch preflight passed", async () => {
      await run("/bin/sh", ["-c", claudeManagedPolicyCheck(policy())]);
      await mkdir(policy());
      expect(await start(policy())).toEqual({ code: 78, started: false });
    });

    it.each([
      ["an empty policy directory", async () => {}],
      [
        "an unknown file in the policy directory",
        async (p: string) => writeFile(join(p, "README"), ""),
      ],
      [
        "managed-settings.json",
        async (p: string) => writeFile(join(p, "managed-settings.json"), "{}"),
      ],
      [
        "an empty managed-settings.d",
        async (p: string) => mkdir(join(p, "managed-settings.d")),
      ],
      [
        "a managed-settings.d entry",
        async (p: string) => {
          await mkdir(join(p, "managed-settings.d"));
          await writeFile(join(p, "managed-settings.d/10-x.json"), "{}");
        },
      ],
      [
        "managed-mcp.json",
        async (p: string) => writeFile(join(p, "managed-mcp.json"), "{}"),
      ],
      [
        "a symlinked managed-settings.json",
        async (p: string) => {
          await writeFile(join(root, "elsewhere.json"), "{}");
          await symlink(
            join(root, "elsewhere.json"),
            join(p, "managed-settings.json"),
          );
        },
      ],
      [
        "a dangling managed-settings.json symlink",
        async (p: string) =>
          symlink(join(root, "missing.json"), join(p, "managed-settings.json")),
      ],
      [
        "a dangling managed-settings.d symlink",
        async (p: string) =>
          symlink(join(root, "missing.d"), join(p, "managed-settings.d")),
      ],
    ])("%s", async (_name, plant) => {
      await mkdir(policy());
      await plant(policy());
      expect(await start(policy())).toEqual({ code: 78, started: false });
    });

    it.each([
      [
        "a symlinked policy directory",
        async () => {
          await mkdir(join(root, "real"));
          await symlink(join(root, "real"), policy());
        },
      ],
      [
        "a dangling policy directory symlink",
        async () => symlink(join(root, "missing"), policy()),
      ],
      ["a file at the policy path", async () => writeFile(policy(), "{}")],
    ])("%s", async (_name, plant) => {
      await plant();
      expect(await start(policy())).toEqual({ code: 78, started: false });
    });
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

  describe("the agent's jobs", () => {
    // A stand-in adapter (its command line names claude-agent-acp) in a run
    // marked like the launcher's: an MCP server of its own (node), a shell
    // still running a command (as a background Bash call keeps it), and a
    // job whose shell exited (`cmd &`), reparented away from the adapter.
    // each start its own run, so an earlier test's leftovers never count
    const start = async () => {
      const RUN = randomUUID();
      const pidFile = join(root, "pid");
      const script = join(root, "adapter.js");
      await writeFile(
        script,
        `const { spawn } = require("child_process");
const fs = require("fs");
const dir = ${JSON.stringify(root)};
spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
  .on("spawn", function () { fs.writeFileSync(dir + "/mcp", String(this.pid)); });
// an own process whose environ the probe can read (node's is not: it has
// file capabilities, so it is not dumpable)
spawn("sleep", ["60"], { stdio: "ignore" })
  .on("spawn", function () { fs.writeFileSync(dir + "/ownsleep", String(this.pid)); });
const shell = spawn("/bin/sh", ["-c", "sleep 60; true"], { stdio: "ignore" });
fs.writeFileSync(dir + "/shell", String(shell.pid));
spawn("/bin/sh", ["-c", "sleep 60 & echo $! > " + dir + "/job; exit 0"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`,
      );
      const fake = jest.requireActual("node:child_process")
        .spawn as typeof realSpawn;
      const adapter = fake(
        "/bin/sh",
        [
          "-c",
          `${startTimeFn}\necho "$$ $(st $$)" > ${pidFile}; exec ${process.execPath} ${script} claude-agent-acp`,
        ],
        { stdio: "ignore", env: { ...process.env, COCALC_AGENT_RUN: RUN } },
      );
      const pidOf = async (name: string) => {
        for (let i = 0; i < 100; i++) {
          const pid = parseInt(
            await readFile(join(root, name), "utf8").catch(() => ""),
          );
          if (pid > 0) return pid;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw Error(`no ${name}`);
      };
      const pids = {
        mcp: await pidOf("mcp"),
        ownSleep: await pidOf("ownsleep"),
        shell: await pidOf("shell"),
        job: await pidOf("job"),
      };
      const adapterPid = parseInt(await readFile(pidFile, "utf8"));
      const cleanup = () => {
        // the shell's own command too, which killing the shell would orphan
        try {
          jest
            .requireActual("node:child_process")
            .execFileSync("pkill", ["-KILL", "-P", `${pids.shell}`]);
        } catch {}
        for (const pid of [adapterPid, ...Object.values(pids)])
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
      };
      return { pidFile, adapter, adapterPid, pids, cleanup, run: RUN };
    };
    const probe = async (pidFile: string, runId: string) =>
      (
        await run("/bin/sh", [
          "-c",
          claudeInProjectBackgroundWorkScript(pidFile, runId),
        ])
      ).stdout.trim();

    it("finds a running job, also once reparented, and none when they end", async () => {
      const { pidFile, pids, cleanup, run: runId } = await start();
      try {
        // the precondition this test relies on: an own process whose
        // environment the probe can read, carrying this run's marker (if it
        // were unreadable, a probe counting own processes would go unseen)
        const ownEnv = (
          await readFile(`/proc/${pids.ownSleep}/environ`, "utf8")
        )
          .split("\0")
          .filter((entry) => entry.startsWith("COCALC_AGENT_RUN="));
        expect(ownEnv).toEqual([`COCALC_AGENT_RUN=${runId}`]);
        expect(await probe(pidFile, runId)).toBe("busy");
        // another run's marker is not this one's
        expect(
          await probe(pidFile, "99999999-2222-4333-8444-555555555555"),
        ).toBe("idle");
        // the shell's command, then the shell: both done
        await run("pkill", ["-KILL", "-P", `${pids.shell}`]).catch(() => {});
        try {
          // the shell may already have exited once its command was killed
          process.kill(pids.shell, "SIGKILL");
        } catch (err: any) {
          if (err?.code !== "ESRCH") throw err;
        }
        for (let i = 0; i < 50 && alive(pids.shell); i++)
          await new Promise((r) => setTimeout(r, 20));
        expect(alive(pids.shell)).toBe(false);
        expect(alive(pids.job)).toBe(true);
        expect(await probe(pidFile, runId)).toBe("busy"); // the reparented job
        process.kill(pids.job, "SIGKILL");
        // killed processes leave the process table asynchronously
        let state = "busy";
        for (let i = 0; i < 100 && state !== "idle"; i++) {
          await new Promise((r) => setTimeout(r, 50));
          state = await probe(pidFile, runId);
        }
        // the agent's own processes (its MCP servers, one of them with a
        // readable environ carrying the marker) are no job
        expect(alive(pids.mcp)).toBe(true);
        expect(alive(pids.ownSleep)).toBe(true);
        expect(state).toBe("idle");
      } finally {
        cleanup();
      }
    }, 20_000);

    it("between turns, stop ends the agent and leaves its jobs running", async () => {
      const { pidFile, adapterPid, pids, cleanup } = await start();
      try {
        await run("/bin/sh", [
          "-c",
          claudeInProjectStopScript(pidFile, { jobs: false }),
        ]);
        await new Promise((r) => setTimeout(r, 200));
        expect(alive(adapterPid)).toBe(false);
        expect(alive(pids.mcp)).toBe(false);
        expect(alive(pids.ownSleep)).toBe(false);
        expect(alive(pids.shell)).toBe(true);
        expect(alive(pids.job)).toBe(true);
      } finally {
        cleanup();
      }
    }, 20_000);

    it("during a turn, stop ends the commands the agent is running too", async () => {
      const { pidFile, adapterPid, pids, cleanup } = await start();
      try {
        await run("/bin/sh", ["-c", claudeInProjectStopScript(pidFile)]);
        await new Promise((r) => setTimeout(r, 200));
        expect(alive(adapterPid)).toBe(false);
        expect(alive(pids.mcp)).toBe(false);
        expect(alive(pids.shell)).toBe(false);
      } finally {
        cleanup();
      }
    }, 20_000);
  });

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

  let relay: {
    baseUrl: string;
    token: string;
    beginTurn: jest.Mock;
    endTurn: jest.Mock;
    close: jest.Mock;
  };
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
      beginTurn: jest.fn(),
      endTurn: jest.fn(),
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
    // the route pinned at the flag-settings tier; never the token
    const noProxy = "localhost,127.0.0.1,::1,host.containers.internal";
    expect(proc.pinnedSettingsEnv).toEqual({
      ANTHROPIC_BASE_URL: relay.baseUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    });
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
      // only Claude Code's model endpoints, POST only (S1)
      allowedPaths: ["/v1/messages", "/v1/messages/count_tokens"],
      allowedMethods: ["POST"],
      credentialHeader: "authorization",
      tokenPrefix: "sk-ant-oat01-cocalc-",
    });
    expect(await policy.credentialValue()).toBe(`Bearer ${REAL_TOKEN}`);

    await proc.stop();
    // the managed-policy check before launch, then the stop script
    expect(execFile).toHaveBeenCalledTimes(2);
    const calls = (execFile as unknown as jest.Mock).mock.calls;
    expect(calls[0][1]).toContain(`project-${projectId}`);
    expect(calls[0][1].at(-1)).toBe(claudeManagedPolicyCheck());
    expect(calls[1][1]).toContain(`project-${projectId}`);
    expect(relay.close).toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalled();
  });

  it("refuses a project with a Claude Code managed policy before any credential exists", async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_cmd, _args, _opts, cb) =>
        cb(Object.assign(Error("exit 78"), { code: 78 }), "", ""),
    );
    await expect(
      launchClaudeSubscriptionInProject(binding, conversation),
    ).rejects.toThrow(MANAGED_POLICY_MESSAGE);
    expect(startProviderRelaySession).not.toHaveBeenCalled();
    expect(createProjectCliTokenLease).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not start when the managed-policy check cannot run", async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_cmd, _args, _opts, cb) =>
        cb(Object.assign(Error("no container"), { code: 125 }), "", ""),
    );
    await expect(
      launchClaudeSubscriptionInProject(binding, conversation),
    ).rejects.toThrow(/managed settings/);
    expect(startProviderRelaySession).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("checks for a managed policy again at each turn start, failing the turn before the relay accepts it", async () => {
    const proc = await launchClaudeSubscriptionInProject(binding, conversation);
    const mock = execFile as unknown as jest.Mock;
    await proc.beginConnectorTurn!({ path: "a.chat" } as any);
    await proc.endConnectorTurn!();
    expect(mock.mock.calls.map((c) => c[1].at(-1))).toEqual([
      claudeManagedPolicyCheck(),
      claudeManagedPolicyCheck(),
    ]);
    // installed mid-session
    mock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(Object.assign(Error("exit 78"), { code: 78 }), "", ""),
    );
    await expect(
      proc.beginConnectorTurn!({ path: "a.chat" } as any),
    ).rejects.toThrow(MANAGED_POLICY_MESSAGE);
    expect(relay.beginTurn).toHaveBeenCalledTimes(1);
    expect(lease.beginConnectorTurn).toHaveBeenCalledTimes(1);
  });

  it("stops only the agent between turns, and its running commands too during a turn", async () => {
    const mock = execFile as unknown as jest.Mock;
    const stopScript = () => mock.mock.calls.at(-1)[1].at(-1) as string;
    const idle = await launchClaudeSubscriptionInProject(binding, conversation);
    await idle.beginConnectorTurn!({ path: "a.chat" } as any);
    await idle.endConnectorTurn!();
    await idle.stop();
    expect(stopScript()).toContain("agent() {");
    expect(stopScript()).not.toContain("tree() {");

    const busy = await launchClaudeSubscriptionInProject(binding, conversation);
    await busy.beginConnectorTurn!({ path: "a.chat" } as any);
    await busy.stop();
    expect(stopScript()).toContain("tree() {");
  }, 15_000);

  it("asks the container for background work with the run's marker", async () => {
    const mock = execFile as unknown as jest.Mock;
    const proc = await launchClaudeSubscriptionInProject(binding, conversation);
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[];
    const run = args
      .find((a) => a.startsWith("COCALC_AGENT_RUN="))!
      .slice("COCALC_AGENT_RUN=".length);
    expect(run).toMatch(/^[0-9a-f-]{36}$/);
    mock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "busy\n", ""));
    expect(await proc.hasBackgroundWork!()).toBe(true);
    expect(mock.mock.calls.at(-1)[1].at(-1)).toContain(
      `COCALC_AGENT_RUN=${run}`,
    );
    mock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "idle\n", ""));
    expect(await proc.hasBackgroundWork!()).toBe(false);
    mock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(Object.assign(Error("gone"), { code: 125 }), "", ""),
    );
    await expect(proc.hasBackgroundWork!()).rejects.toThrow();
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

  it("starts a relay turn with each turn, and ends it even when the connector's end fails (B2)", async () => {
    const proc = await launchClaudeSubscriptionInProject(binding, conversation);
    expect(relay.beginTurn).not.toHaveBeenCalled();
    const order: string[] = [];
    relay.beginTurn.mockImplementation(() => order.push("relay begin"));
    relay.endTurn.mockImplementation(() => order.push("relay end"));
    lease.beginConnectorTurn.mockImplementation(() => order.push("connector"));
    lease.endConnectorTurn.mockImplementation(async () => {
      order.push("connector end");
    });
    await proc.beginConnectorTurn!({ path: "a.chat" } as any);
    await proc.endConnectorTurn!();
    lease.endConnectorTurn.mockImplementation(async () => {
      order.push("connector end failed");
      throw Error("revocation unconfirmed");
    });
    await proc.beginConnectorTurn!({ path: "a.chat" } as any);
    await expect(proc.endConnectorTurn!()).rejects.toThrow("unconfirmed");
    expect(order).toEqual([
      "relay begin",
      "connector",
      "connector end",
      "relay end",
      "relay begin",
      "connector",
      "connector end failed",
      "relay end",
    ]);
  });

  it("ends the relay turn when the connector cannot begin (B2)", async () => {
    const proc = await launchClaudeSubscriptionInProject(binding, conversation);
    lease.beginConnectorTurn.mockRejectedValue(Error("connector unavailable"));
    await expect(
      proc.beginConnectorTurn!({ path: "a.chat" } as any),
    ).rejects.toThrow("connector unavailable");
    expect(relay.beginTurn).toHaveBeenCalledTimes(1);
    expect(relay.endTurn).toHaveBeenCalledTimes(1);
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

describe("superviseInProjectProcess", () => {
  const GRACE = 50;
  const fakeProc = () => {
    const proc: any = new EventEmitter();
    proc.stdin = { end: jest.fn() };
    // by default the client's stdio never closes
    proc.kill = jest.fn();
    return proc;
  };
  const credentials = () => {
    const closes = { relay: 0, lease: 0 };
    const release = jest.fn(async () => {
      closes.relay++;
      await new Promise((r) => setTimeout(r, 5));
      closes.lease++;
    });
    return { closes, release };
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("releases at exit without waiting for close, and closes after a grace", async () => {
    const proc = fakeProc();
    const { closes, release } = credentials();
    const { closed } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {},
      graceMs: GRACE,
    });
    let done = false;
    void closed.then(() => (done = true));
    proc.emit("exit", 0, null);
    await tick();
    expect(closes).toEqual({ relay: 1, lease: 1 });
    expect(done).toBe(false);
    await new Promise((r) => setTimeout(r, GRACE + 10));
    expect(done).toBe(true);
  });

  it("releases on a spawn error with neither exit nor close", async () => {
    const proc = fakeProc();
    const { closes, release } = credentials();
    const { closed } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {},
      graceMs: GRACE,
    });
    proc.emit("error", Error("spawn podman ENOENT"));
    await closed;
    await tick();
    expect(closes).toEqual({ relay: 1, lease: 1 });
  });

  it("stop returns within its bound when close never fires, credentials released", async () => {
    const proc = fakeProc();
    const { closes, release } = credentials();
    const { stop } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {},
      graceMs: GRACE,
    });
    const started = Date.now();
    await stop();
    expect(Date.now() - started).toBeLessThan(5 * GRACE);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(closes).toEqual({ relay: 1, lease: 1 });
  });

  it("stop returns within its bound even if the release never settles", async () => {
    const proc = fakeProc();
    let closedFirst = false;
    // the security-relevant steps run before the release's first wait, as
    // the launcher's do (the relay closed, the bearer file removed)
    const release = jest.fn(() => {
      closedFirst = true;
      return new Promise<void>(() => {});
    });
    const { stop } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {},
      graceMs: GRACE,
    });
    const started = Date.now();
    await stop();
    expect(Date.now() - started).toBeLessThan(5 * GRACE);
    expect(closedFirst).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("releases each credential exactly once under concurrent exit, stop and close", async () => {
    const proc = fakeProc();
    const { closes, release } = credentials();
    const { stop } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {},
      graceMs: GRACE,
    });
    proc.emit("exit", 0, null);
    const stopping = [stop(), stop()];
    proc.emit("close", 0, null);
    await Promise.all(stopping);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closes).toEqual({ relay: 1, lease: 1 });
  });

  it("releases when the kill throws and when stopping in the container fails", async () => {
    const proc = fakeProc();
    proc.kill = jest.fn(() => {
      throw Error("ESRCH");
    });
    const { closes, release } = credentials();
    const { stop } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: async () => {
        throw Error("podman exec failed");
      },
      graceMs: GRACE,
    });
    await stop();
    expect(closes).toEqual({ relay: 1, lease: 1 });
  });

  it("stop releases before the in-container stop finishes", async () => {
    const proc = fakeProc();
    const { closes, release } = credentials();
    let finish!: () => void;
    const { stop } = superviseInProjectProcess({
      proc,
      release,
      stopInContainer: () => new Promise<void>((r) => (finish = r)),
      graceMs: GRACE,
    });
    const stopping = stop();
    await tick();
    expect(closes).toEqual({ relay: 1, lease: 1 });
    finish();
    await stopping;
  });

  describe("with a real relay and a job holding the client's stdout", () => {
    const realProxy = jest.requireActual("../codex/site-funded-proxy");
    let upstream: import("node:http").Server;
    beforeAll(async () => {
      realProxy.setSiteFundedCodexProxyPortsForTests([0]);
      const { createServer } = await import("node:http");
      upstream = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((r) =>
        upstream.listen(0, "127.0.0.1", () => r()),
      );
    });
    afterAll(async () => {
      await realProxy.shutdownSiteFundedCodexProxyForTests();
      upstream.close();
    });
    const post = async (baseUrl: string, token: string) => {
      const res = await fetch(
        `${baseUrl.replace("host.containers.internal", "127.0.0.1")}/v1/messages`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        },
      );
      await res.text();
      return res.status;
    };

    it("refuses the relay token once the client exits, though its stdout stays open", async () => {
      const port = (upstream.address() as import("node:net").AddressInfo).port;
      const relay = await realProxy.startProviderRelaySession({
        upstream: `http://127.0.0.1:${port}`,
        allowedPathPrefix: "/v1/",
        allowedPaths: ["/v1/messages"],
        allowedMethods: ["POST"],
        credentialHeader: "authorization",
        credentialValue: () => "Bearer fake-upstream",
        tokenPrefix: "sk-ant-oat01-cocalc-",
        allowHttpForTests: true,
      });
      relay.beginTurn?.();
      expect(await post(relay.baseUrl, relay.token)).toBe(200);
      const leaseFile = join(root, "token");
      await writeFile(leaseFile, "fake\n");
      // the client exits; a job it started keeps its stdout and stderr open
      const child = (
        jest.requireActual("node:child_process").spawn as typeof realSpawn
      )("/bin/sh", ["-c", "sleep 30 & echo $!; exit 0"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // supervised from the spawn on, as the launcher does
      const { closed } = superviseInProjectProcess({
        proc: child,
        release: async () => {
          relay.close();
          await rm(leaseFile, { force: true });
        },
        stopInContainer: async () => {},
        graceMs: GRACE,
      });
      let jobPid = 0;
      child.stdout!.once("data", (d) => (jobPid = parseInt(`${d}`)));
      let closedAt = 0;
      child.once("close", () => (closedAt = Date.now()));
      try {
        await closed;
        expect(closedAt).toBe(0); // stdio still held by the job
        expect(jobPid).toBeGreaterThan(0);
        expect(await post(relay.baseUrl, relay.token)).toBe(401);
        await expect(lstat(leaseFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (jobPid) process.kill(jobPid, "SIGKILL");
        relay.close();
      }
    });
  });
});
