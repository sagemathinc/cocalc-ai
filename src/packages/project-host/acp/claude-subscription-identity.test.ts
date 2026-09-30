/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchClaudeSubscriptionController as launch } from "./claude-subscription-controller";
import { createProjectCliTokenLease } from "../codex/codex-project";
import { createClaudeProjectToolBridge } from "./claude-project-tool-bridge";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { execFile, spawn } from "node:child_process";

jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));
jest.mock("../codex/codex-project", () => ({
  createProjectCliTokenLease: jest.fn(),
  ensureProjectContainerRunning: jest.fn(),
  getBuiltinClaudeSkillText: async () => "CoCalc skill",
  applyProjectRuntimeCliEnv: jest.fn(),
  resolveProjectRuntimeApiUrl: () => "http://project-hub",
}));
jest.mock("./claude-subscription-registry", () => ({
  getClaudeSubscriptionCredential: async () => ({ payload: {}, identity: {} }),
  syncClaudeSubscriptionCredential: jest.fn(async ({ baseline }) => baseline),
}));
jest.mock("./claude-subscription-home", () => ({
  restoreClaudeSubscriptionHome: jest.fn(),
  claudeSubscriptionBundleFiles: () => new Map(),
}));
jest.mock("./claude-subscription-paths", () => ({
  claudeControllerHomePrefix: () => join(tmpdir(), "claude-identity-test-"),
  CLAUDE_CONTROLLER_HOME_LABEL: "cocalc.claude.controller-home",
}));
jest.mock("./claude-project-tool-bridge", () => ({
  createClaudeProjectToolBridge: jest.fn(),
  CLAUDE_PROJECT_TOOL_MOUNT: "/run/cocalc/agent-tools",
}));
jest.mock("./harness-reaper", () => ({
  harnessOwner: async () => "owner",
  HARNESS_OWNER_LABEL: "cocalc.acp.owner",
}));
jest.mock("@cocalc/project-runner/run/filesystem", () => ({
  localPath: jest.fn(),
}));
jest.mock("@cocalc/project-runner/run/sandbox-exec", () => ({
  sandboxExec: jest.fn(),
}));
jest.mock("@cocalc/project-runner/run/rootfs-base", () => ({
  extractBaseImage: async () => "/rootfs",
}));
jest.mock("@cocalc/project-runner/run/mounts", () => ({
  getNodeRuntimeMounts: () => ({}),
}));
jest.mock("@cocalc/project-runner/run/podman", () => ({
  projectPoolPodmanLauncher: () => ({ command: "podman", argsPrefix: [] }),
  podmanRuntimeArgs: async () => [],
  forceKillContainerProcesses: jest.fn(),
}));
jest.mock("@cocalc/backend/podman/env", () => ({ podmanEnv: () => ({}) }));
jest.mock("@cocalc/backend/podman", () => ({
  mountArg: ({ source, target }) => `mount:${source}:${target}`,
}));

const binding = {
  projectId: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  profile: {
    version: 2 as const,
    kind: "acp" as const,
    id: "claude-code" as const,
    revision: "0.81.1",
    cwd: "/home/user/work",
    credentialMode: "project-managed" as const,
    executionPolicy: "full-access" as const,
  },
  credential: {
    version: 1 as const,
    provider: "anthropic" as const,
    mode: "account-subscription" as const,
    credentialId: "00000000-0000-4000-8000-000000000003",
  },
};
const conversation = { path: "/home/user/agent.chat", threadId: "thread-a" };
const closeLease = jest.fn();
let home: string;

beforeEach(async () => {
  jest.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "claude-identity-project-"));
  jest
    .mocked(localPath)
    .mockResolvedValue({ home, scratch: "/scratch" } as any);
  jest.mocked(createProjectCliTokenLease).mockResolvedValue({
    containerPath: "/tmp/scoped/token",
    identityContainerPath: "/tmp/scoped/identity.json",
    hostPath: "/host/token",
    setAgentSessionKey: jest.fn(),
    close: closeLease,
  });
  jest.mocked(createClaudeProjectToolBridge).mockResolvedValue({
    directory: "/tools",
    close: jest.fn(),
    cancel: jest.fn(),
    resume: jest.fn(),
  } as any);
  jest.mocked(sandboxExec).mockResolvedValue({ cleanupConfirmed: true } as any);
  (execFile as unknown as jest.Mock).mockImplementation((...args) =>
    args.at(-1)(null),
  );
  (spawn as unknown as jest.Mock).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => child.emit("close"),
    });
    return child;
  });
});
afterEach(async () => rm(home, { recursive: true, force: true }));

test("registered subscription agent gets its identity only in project tools", async () => {
  const handle = await launch(binding, "agent", conversation);
  try {
    expect(createProjectCliTokenLease).toHaveBeenCalledWith({
      projectId: binding.projectId,
      accountId: binding.accountId,
      home,
      scratch: "/scratch",
      agentSessionKey: JSON.stringify([
        "claude-subscription",
        binding.projectId,
        binding.accountId,
        binding.credential.credentialId,
        conversation.path,
        conversation.threadId,
      ]),
      currentEnv: {
        COCALC_CODEX_CHAT_PATH: conversation.path,
        COCALC_CODEX_THREAD_ID: conversation.threadId,
      },
    });
    const execute = jest.mocked(createClaudeProjectToolBridge).mock.calls[0][1];
    await execute(
      "project chat agent whoami",
      undefined,
      new AbortController().signal,
    );
    expect(sandboxExec).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: binding.projectId,
        cwd: binding.profile.cwd,
        env: expect.objectContaining({
          COCALC_CODEX_CHAT_PATH: conversation.path,
          COCALC_CODEX_THREAD_ID: conversation.threadId,
          COCALC_AGENT_IDENTITY_FILE: "/tmp/scoped/identity.json",
          COCALC_BEARER_TOKEN: "",
          COCALC_AGENT_TOKEN: "",
        }),
      }),
    );
    const controllerArgs = (execFile as unknown as jest.Mock).mock.calls[0][1];
    expect(controllerArgs.join(" ")).not.toMatch(
      /scoped\/identity|scoped\/token/,
    );
  } finally {
    await handle.stop();
  }
  expect(closeLease).toHaveBeenCalledTimes(1);
});

test.each([
  undefined,
  { path: "", threadId: "thread" },
  { path: "a.chat", threadId: "" },
])("agent launch rejects missing conversation context: %s", async (context) => {
  await expect(launch(binding, "agent", context)).rejects.toThrow(
    "admitted conversation",
  );
  expect(createProjectCliTokenLease).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

test("usage lookup does not acquire project or agent authority", async () => {
  const handle = await launch(binding, "usage");
  await handle.stop();
  expect(createProjectCliTokenLease).not.toHaveBeenCalled();
  expect(createClaudeProjectToolBridge).not.toHaveBeenCalled();
});

test("unregistered chat does not inherit another agent identity", async () => {
  jest.mocked(createProjectCliTokenLease).mockResolvedValue({
    containerPath: "/tmp/scoped/token",
    hostPath: "/host/token",
    setAgentSessionKey: jest.fn(),
    close: closeLease,
  });
  const handle = await launch(binding, "agent", conversation);
  try {
    const execute = jest.mocked(createClaudeProjectToolBridge).mock.calls[0][1];
    await execute(
      "project chat agent whoami",
      undefined,
      new AbortController().signal,
    );
    expect(
      jest.mocked(sandboxExec).mock.calls[0][0].env?.COCALC_AGENT_IDENTITY_FILE,
    ).toBe("");
  } finally {
    await handle.stop();
  }
});
