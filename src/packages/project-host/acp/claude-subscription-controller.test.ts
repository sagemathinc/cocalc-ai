/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  CLAUDE_CONTROLLER_BASE_IMAGE,
  claudeSubscriptionContainerArgs,
  cleanupClaudeSubscriptionController,
  ensureClaudeTranscriptDirectory,
} from "./claude-subscription-controller";
import { mountArg } from "@cocalc/backend/podman";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("controller uses the same normalized image cache key as project startup", () => {
  expect(CLAUDE_CONTROLLER_BASE_IMAGE).toBe("docker.io/buildpack-deps:26.04");
});

test("controller overlays the immutable image while keeping the root read-only", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "readonly-cache",
    projectId: "project",
    owner: "owner",
    home: "/auth",
    rootfs: "/immutable-image",
    claudeCodeDir: "/tools/v1/claude-code",
    nodeMounts: {},
    uid: 1000,
    gid: 1000,
  });
  expect(args[args.indexOf("--rootfs") + 1]).toBe("/immutable-image:O");
  expect(args).toContain("--read-only");
  expect(args).toContain("--cap-drop=all");
  expect(args).toContain("--security-opt=no-new-privileges");
});

test("a subscription token is passed by env file, never on the command line", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "token",
    projectId: "project",
    owner: "owner",
    home: "/auth",
    rootfs: "/rootfs",
    claudeCodeDir: "/tools/v1/claude-code",
    nodeMounts: {},
    uid: 1000,
    gid: 1000,
    envFile: "/auth/.cocalc-auth.env",
  });
  expect(args[args.indexOf("--env-file") + 1]).toBe("/auth/.cocalc-auth.env");
  expect(args.join(" ")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test.each([undefined, true, false])(
  "connector preference %s preserves explicit project tools",
  (claudeAiConnectors) => {
    const args = claudeSubscriptionContainerArgs({
      name: "connectors",
      projectId: "project",
      owner: "owner",
      home: "/auth",
      rootfs: "/rootfs",
      claudeCodeDir: "/tools/v1/claude-code",
      nodeMounts: {},
      uid: 1000,
      gid: 1000,
      toolBridgeDirectory: "/private-tools",
      claudeAiConnectors,
    });
    expect(args.includes("ENABLE_CLAUDEAI_MCP_SERVERS=false")).toBe(
      claudeAiConnectors === false,
    );
    expect(args).toContain("mount:/private-tools:/run/cocalc/agent-tools:true");
    expect(args).toContain("--network=slirp4netns");
  },
);

test("Claude transcript survives a controller restart without entering the auth bundle", async () => {
  const projectHome = await mkdtemp(join(tmpdir(), "claude-transcript-test-"));
  const options = {
    projectHome,
    accountId: "00000000-0000-4000-8000-000000000002",
    credentialId: "00000000-0000-4000-8000-000000000003",
  };
  try {
    const first = await ensureClaudeTranscriptDirectory(options);
    await writeFile(join(first, "turn.jsonl"), "transcript");
    const second = await ensureClaudeTranscriptDirectory(options);
    expect(second).toBe(first);
    expect(await readFile(join(second, "turn.jsonl"), "utf8")).toBe(
      "transcript",
    );
  } finally {
    await rm(projectHome, { recursive: true, force: true });
  }
});

test("Claude transcript mount rejects a project-controlled symlink", async () => {
  const projectHome = await mkdtemp(join(tmpdir(), "claude-transcript-test-"));
  try {
    await symlink(tmpdir(), join(projectHome, ".local"));
    await expect(
      ensureClaudeTranscriptDirectory({
        projectHome,
        accountId: "00000000-0000-4000-8000-000000000002",
        credentialId: "00000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow("Unsafe Claude transcript directory");
  } finally {
    await rm(projectHome, { recursive: true, force: true });
  }
});

describe("Claude transcript lookup after reconnect", () => {
  let projectHome: string;
  const accountId = "00000000-0000-4000-8000-000000000002";
  const oldCredential = "00000000-0000-4000-8000-000000000003";
  const credentialId = "00000000-0000-4000-8000-000000000004";
  const sessionId = "00000000-0000-4000-8000-000000000005";
  let oldDirectory: string;
  beforeEach(async () => {
    projectHome = await mkdtemp(join(tmpdir(), "claude-reconnect-test-"));
    oldDirectory = await ensureClaudeTranscriptDirectory({
      projectHome,
      accountId,
      credentialId: oldCredential,
    });
    await mkdir(join(oldDirectory, "-workspace"));
    await writeFile(
      join(oldDirectory, "-workspace", `${sessionId}.jsonl`),
      "saved context",
    );
  });
  afterEach(async () => {
    await rm(projectHome, { recursive: true, force: true });
  });
  const lookup = (extra = {}) =>
    ensureClaudeTranscriptDirectory({
      projectHome,
      accountId,
      credentialId,
      sessionId,
      ...extra,
    });

  test("resume and fork use the original tree without moving or replacing context", async () => {
    const copyId = "00000000-0000-4000-8000-000000000006";
    const source = await lookup();
    expect(source).toBe(oldDirectory);
    // A native fork writes its new transcript in the mounted source tree.
    await writeFile(
      join(source, "-workspace", `${copyId}.jsonl`),
      "copied context",
    );
    expect(await lookup({ sessionId: copyId })).toBe(oldDirectory);
    expect(
      await readFile(join(source, "-workspace", `${sessionId}.jsonl`), "utf8"),
    ).toBe("saved context");
    expect(await lookup()).toBe(oldDirectory);
  });

  test("fresh sessions and explicit resets keep the current credential tree", async () => {
    expect(await lookup({ sessionId: undefined })).toBe(
      join(
        projectHome,
        ".local/share/cocalc/claude-sessions",
        accountId,
        credentialId,
      ),
    );
    expect(await lookup({ sessionId: "" })).not.toBe(oldDirectory);
  });

  test("never searches another CoCalc account or project", async () => {
    expect(
      await lookup({ accountId: "00000000-0000-4000-8000-000000000007" }),
    ).not.toBe(oldDirectory);
    const otherProject = join(projectHome, "other-project");
    await mkdir(otherProject);
    expect(await lookup({ projectHome: otherProject })).not.toBe(oldDirectory);
  });

  test("missing context remains missing instead of choosing an unrelated transcript", async () => {
    expect(
      await lookup({ sessionId: "00000000-0000-4000-8000-000000000008" }),
    ).not.toBe(oldDirectory);
  });

  test("duplicate session IDs fail closed even if one belongs to the current credential", async () => {
    const current = await lookup({ sessionId: undefined });
    await mkdir(join(current, "-workspace"));
    await writeFile(
      join(current, "-workspace", `${sessionId}.jsonl`),
      "different context",
    );
    await expect(lookup()).rejects.toThrow("Ambiguous Claude transcript");
    await expect(lookup()).rejects.toThrow(
      join(oldDirectory, "-workspace", `${sessionId}.jsonl`),
    );
    await expect(lookup()).rejects.toThrow(
      join(current, "-workspace", `${sessionId}.jsonl`),
    );
    expect(
      await readFile(join(current, "-workspace", `${sessionId}.jsonl`), "utf8"),
    ).toBe("different context");
  });

  test.each(["credential", "workspace", "transcript"])(
    "rejects a symlink at the %s boundary",
    async (boundary) => {
      const target =
        boundary === "credential"
          ? oldDirectory
          : boundary === "workspace"
            ? join(oldDirectory, "-workspace")
            : join(oldDirectory, "-workspace", `${sessionId}.jsonl`);
      await rm(target, { recursive: true });
      await symlink(tmpdir(), target);
      await expect(lookup()).rejects.toThrow("Unsafe Claude transcript");
    },
  );

  test("rejects path traversal in a saved session ID", async () => {
    await expect(lookup({ sessionId: "../../elsewhere" })).rejects.toThrow(
      "Invalid Claude transcript session",
    );
  });
});

jest.mock("@cocalc/backend/podman", () => ({
  mountArg: jest.fn(
    ({ source, target, readOnly }) =>
      `mount:${source}:${target}:${readOnly === true}`,
  ),
}));
jest.mock("../codex/codex-project", () => ({
  ensureProjectContainerRunning: jest.fn(),
}));

test("subscription controller mounts only its transcript, not project secrets or network", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "claude-controller-test",
    projectId: "00000000-0000-4000-8000-000000000001",
    owner: "123:00000000-0000-4000-8000-000000000002:456",
    rootfs: "/trusted-base-rootfs",
    home: "/private-auth-home",
    claudeCodeDir: "/tools/v7/claude-code",
    toolBridgeDirectory: "/private-tool-bridge",
    sessionDirectory: "/project-claude-transcript",
    nodeMounts: { "/managed-node": "/opt/cocalc/bin" },
    uid: 1000,
    gid: 1000,
  });
  expect(args).toContain("--read-only");
  expect(args).toContain("--cap-drop=all");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args).toContain("/workspace:mode=1777");
  expect(args).toContain("/tmp:mode=1777");
  expect(args).toContain("cocalc.runtime=acp");
  expect(args).toContain(
    "cocalc.acp.owner=123:00000000-0000-4000-8000-000000000002:456",
  );
  expect(args).toContain("--network=slirp4netns");
  expect(args).not.toContain("--network=container:project-test");
  expect(args).toContain("mount:/private-auth-home:/home/claude:false");
  expect(args).toContain(
    "mount:/project-claude-transcript:/home/claude/projects:false",
  );
  expect(args).toContain(
    "mount:/tools/v7/claude-code:/opt/cocalc/bin2/claude-code:true",
  );
  expect(args).toContain("mount:/managed-node:/opt/cocalc/bin:true");
  expect(mountArg).toHaveBeenCalledWith({
    source: "/managed-node",
    target: "/opt/cocalc/bin",
    readOnly: true,
    options: "nosuid",
  });
  expect(args).toContain(
    "mount:/private-tool-bridge:/run/cocalc/agent-tools:true",
  );
  expect(args).not.toContain("--hide-claude-auth");
  expect(args.join(" ")).not.toMatch(
    /project-home|project-secrets|\/run\/secrets|COCALC_BEARER_TOKEN/,
  );
  expect(args.slice(-3)).toEqual([
    "/trusted-base-rootfs:O",
    "/opt/cocalc/bin/node",
    "/opt/cocalc/bin2/claude-code/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  ]);
});

test("credential home is removed after a confirmed stop even if refresh fails", async () => {
  const stopContainer = jest.fn().mockResolvedValue(undefined);
  const closeBridge = jest.fn().mockResolvedValue(undefined);
  const refreshCredential = jest
    .fn()
    .mockRejectedValue(Error("broker unavailable"));
  const removeHome = jest.fn().mockResolvedValue(undefined);
  await expect(
    cleanupClaudeSubscriptionController({
      stopContainer,
      closeBridge,
      refreshCredential,
      removeHome,
      launched: true,
    }),
  ).rejects.toThrow("broker unavailable");
  expect(removeHome).toHaveBeenCalledTimes(1);
});

test("credential home remains when container removal is uncertain", async () => {
  const stopContainer = jest
    .fn()
    .mockRejectedValue(Error("container may be running"));
  const closeBridge = jest.fn();
  const refreshCredential = jest.fn();
  const removeHome = jest.fn();
  await expect(
    cleanupClaudeSubscriptionController({
      stopContainer,
      closeBridge,
      refreshCredential,
      removeHome,
      launched: true,
    }),
  ).rejects.toThrow("container may be running");
  expect(closeBridge).toHaveBeenCalledTimes(1);
  expect(refreshCredential).not.toHaveBeenCalled();
  expect(removeHome).not.toHaveBeenCalled();
});

test("failed startup does not overwrite the stored credential", async () => {
  const refreshCredential = jest.fn();
  const removeHome = jest.fn().mockResolvedValue(undefined);
  await cleanupClaudeSubscriptionController({
    stopContainer: async () => {},
    closeBridge: async () => {},
    refreshCredential,
    removeHome,
    launched: false,
  });
  expect(refreshCredential).not.toHaveBeenCalled();
  expect(removeHome).toHaveBeenCalledTimes(1);
});

test("command authority is revoked before stopping the controller and cleanup survives a bridge error", async () => {
  const order: string[] = [];
  await expect(
    cleanupClaudeSubscriptionController({
      closeBridge: async () => {
        order.push("bridge");
        throw Error("bridge cleanup failed");
      },
      stopContainer: async () => {
        order.push("stop");
      },
      refreshCredential: async () => {
        order.push("refresh");
      },
      removeHome: async () => {
        order.push("home");
      },
      launched: true,
    }),
  ).rejects.toThrow("bridge cleanup failed");
  expect(order).toEqual(["bridge", "stop", "refresh", "home"]);
});

test("restricted egress environment reaches only the controller process", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "restricted",
    projectId: "project",
    owner: "owner",
    home: "/auth",
    rootfs: "/rootfs",
    claudeCodeDir: "/tools/v1/claude-code",
    nodeMounts: {},
    uid: 1000,
    gid: 1000,
    env: { HTTPS_PROXY: "http://cocalc-claude:token@10.1.2.3:4567" },
  });
  const rootfs = args.indexOf("--rootfs");
  const proxy = args.indexOf(
    "HTTPS_PROXY=http://cocalc-claude:token@10.1.2.3:4567",
  );
  expect(proxy).toBeGreaterThan(0);
  expect(args[proxy - 1]).toBe("--env");
  expect(proxy).toBeLessThan(rootfs);
  // Still its own network, not the project's.
  expect(args).toContain("--network=slirp4netns");
});

test("Claude Code's own file memory is off; CoCalc agent memory is used", () => {
  const args = claudeSubscriptionContainerArgs({
    name: "memory",
    projectId: "project",
    owner: "owner",
    home: "/auth",
    rootfs: "/rootfs",
    claudeCodeDir: "/tools/v1/claude-code",
    nodeMounts: {},
    uid: 1000,
    gid: 1000,
  });
  const memory = args.indexOf("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
  expect(args[memory - 1]).toBe("--env");
  expect(memory).toBeLessThan(args.indexOf("--rootfs"));
});
