/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { mountArg } from "@cocalc/backend/podman";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { normalizeRootfsImageName } from "@cocalc/util/rootfs-images";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { getNodeRuntimeMounts } from "@cocalc/project-runner/run/mounts";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import {
  forceKillContainerProcesses,
  podmanRuntimeArgs,
  projectPoolPodmanLauncher,
} from "@cocalc/project-runner/run/podman";
import { extractBaseImage } from "@cocalc/project-runner/run/rootfs-base";
import {
  getClaudeSubscriptionCredential,
  publishClaudeSubscriptionCredential,
} from "./claude-subscription-registry";
import {
  claudeSubscriptionBundlePaths,
  restoreClaudeSubscriptionHome,
} from "./claude-subscription-home";
import {
  CLAUDE_PROJECT_TOOL_MOUNT,
  createClaudeProjectToolBridge,
  type ClaudeProjectToolBridge,
} from "./claude-project-tool-bridge";
import {
  applyProjectRuntimeCliEnv,
  createProjectCliTokenLease,
  ensureProjectContainerRunning,
  getBuiltinClaudeSkillText,
  resolveProjectRuntimeApiUrl,
} from "../codex/codex-project";
import { harnessOwner, HARNESS_OWNER_LABEL } from "./harness-reaper";
import {
  CLAUDE_CONTROLLER_HOME_LABEL,
  claudeControllerHomePrefix,
} from "./claude-subscription-paths";

const CONTROLLER_HOME = "/home/claude";
const CONTROLLER_WORKSPACE = "/workspace";
const MANAGED_HARNESSES = "/opt/cocalc/harnesses";
const logger = getLogger("project-host:acp:claude-subscription-controller");

// Project startup normalizes image references before caching them. Use the
// same cache key or a first Claude turn unnecessarily pulls the base image.
export const CLAUDE_CONTROLLER_BASE_IMAGE = normalizeRootfsImageName(
  DEFAULT_PROJECT_IMAGE,
);

export async function ensureClaudeTranscriptDirectory(options: {
  projectHome: string;
  accountId: string;
  credentialId: string;
}): Promise<string> {
  const { projectHome, accountId, credentialId } = options;
  if (!isValidUUID(accountId) || !isValidUUID(credentialId))
    throw Error("Invalid Claude transcript owner");
  let directory = projectHome;
  for (const part of [
    ".local",
    "share",
    "cocalc",
    "claude-sessions",
    accountId,
    credentialId,
  ]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Unsafe Claude transcript directory");
  }
  return directory;
}

export async function cleanupClaudeSubscriptionController(options: {
  stopContainer: () => Promise<void>;
  closeBridge: () => Promise<void>;
  refreshCredential: () => Promise<void>;
  removeHome: () => Promise<void>;
  launched: boolean;
}): Promise<void> {
  // Revoke command authority even when Podman cannot confirm removal.
  let bridgeError: unknown;
  try {
    await options.closeBridge();
  } catch (error) {
    bridgeError = error;
  }
  await options.stopContainer();
  try {
    if (options.launched) await options.refreshCredential();
  } finally {
    await options.removeHome();
  }
  if (bridgeError) throw bridgeError;
}

export function claudeSubscriptionContainerArgs(options: {
  name: string;
  projectId: string;
  owner: string;
  home: string;
  rootfs: string;
  managedHarnesses: string;
  nodeMounts: Record<string, string>;
  toolBridgeDirectory?: string;
  sessionDirectory?: string;
  uid: number;
  gid: number;
  runtimeArgs?: string[];
}): string[] {
  const {
    name,
    projectId,
    owner,
    home,
    rootfs,
    managedHarnesses,
    nodeMounts,
    toolBridgeDirectory,
    sessionDirectory,
    uid,
    gid,
    runtimeArgs = [],
  } = options;
  const entry = `${MANAGED_HARNESSES}/claude-code/${CLAUDE_CODE_QUALIFICATION.package.version}/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
  return [
    "create",
    ...runtimeArgs,
    "--name",
    name,
    "--label",
    "cocalc.runtime=acp",
    "--label",
    `${HARNESS_OWNER_LABEL}=${owner}`,
    "--label",
    `cocalc.project=${projectId}`,
    "--label",
    `${CLAUDE_CONTROLLER_HOME_LABEL}=${home}`,
    "--interactive",
    "--read-only",
    "--security-opt=no-new-privileges",
    "--cap-drop=all",
    "--pids-limit=128",
    "--network=slirp4netns",
    "--userns=keep-id",
    "--user",
    `${uid}:${gid}`,
    "--workdir",
    CONTROLLER_WORKSPACE,
    "--tmpfs",
    `${CONTROLLER_WORKSPACE}:mode=1777`,
    "--tmpfs",
    "/tmp:mode=1777",
    mountArg({ source: home, target: CONTROLLER_HOME }),
    ...(sessionDirectory
      ? [
          mountArg({
            source: sessionDirectory,
            target: `${CONTROLLER_HOME}/projects`,
          }),
        ]
      : []),
    mountArg({
      source: managedHarnesses,
      target: MANAGED_HARNESSES,
      readOnly: true,
    }),
    ...(toolBridgeDirectory
      ? [
          mountArg({
            source: toolBridgeDirectory,
            target: CLAUDE_PROJECT_TOOL_MOUNT,
            readOnly: true,
          }),
        ]
      : []),
    ...Object.entries(nodeMounts).map(([source, target]) =>
      // Host bootstrap gives Node a file capability for HTTPS. Ignore that
      // capability here so exec succeeds with the controller's empty cap set.
      mountArg({ source, target, readOnly: true, options: "nosuid" }),
    ),
    "--env",
    `HOME=${CONTROLLER_HOME}`,
    "--env",
    `CLAUDE_CONFIG_DIR=${CONTROLLER_HOME}`,
    "--env",
    `XDG_CONFIG_HOME=${CONTROLLER_HOME}`,
    "--env",
    "NO_BROWSER=1",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "PATH=/opt/cocalc/bin:/usr/bin:/bin",
    "--rootfs",
    rootfs,
    "/opt/cocalc/bin/node",
    entry,
  ];
}

/** Credential-bearing controller: no project home, secrets, identity token or project network. */
export async function launchClaudeSubscriptionController(
  binding: HarnessBinding,
): Promise<HarnessProcess> {
  const { projectId, accountId, credential } = binding;
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    credential.mode !== "account-subscription" ||
    credential.provider !== "anthropic"
  )
    throw Error("Invalid Claude subscription controller binding");
  const credentialId = credential.credentialId;
  const skill = await getBuiltinClaudeSkillText();
  const systemPromptAppend = `The CoCalc skill is preloaded below as session instructions, not as a separate Skill tool. Follow it for CoCalc workflows.
This is an isolated subscription controller. Run ALL project filesystem and CLI operations through cocalc_project project_exec, not in the controller. Read applicable project CLAUDE.md instructions through that tool before editing. Skill reference files are available in the project at /home/user/.claude/skills/cocalc/.
Use the exact installed CLI command: "/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js".

<cocalc-skill>
${skill}
</cocalc-skill>`;
  const registered = await getClaudeSubscriptionCredential({
    projectId,
    accountId,
    credentialId,
  });
  await ensureProjectContainerRunning({ projectId, accountId });
  const rootfs = await extractBaseImage(CLAUDE_CONTROLLER_BASE_IMAGE);
  const home = await mkdtemp(claudeControllerHomePrefix());
  const launcher = projectPoolPodmanLauncher(projectId);
  const name = `claude-controller-${projectId}-${randomUUID()}`;
  let created = false;
  let launched = false;
  let toolBridge: ClaudeProjectToolBridge | undefined;
  let cliLease: Awaited<ReturnType<typeof createProjectCliTokenLease>>;
  let stopped: Promise<void> | undefined;
  let cleanupRetries = 0;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const command = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.argsPrefix, ...args],
        {
          cwd: "/",
          env: podmanEnv(),
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
        (error) => {
          if (!error) return resolve();
          reject(
            Object.assign(Error("Claude controller operation failed"), {
              code: error.killed ? "CLAUDE_CONTROLLER_STOP_TIMEOUT" : undefined,
            }),
          );
        },
      );
    });
  const cleanup = () =>
    (stopped ??= cleanupClaudeSubscriptionController({
      stopContainer: async () => {
        if (!created) return;
        const remove = () =>
          command(["rm", "--ignore", "--force", "--time", "0", name]);
        try {
          await remove();
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !==
            "CLAUDE_CONTROLLER_STOP_TIMEOUT"
          )
            throw error;
          await forceKillContainerProcesses(projectId, name);
          await remove();
        }
      },
      closeBridge: async () => {
        const results = await Promise.allSettled([
          toolBridge?.close(),
          cliLease?.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
      refreshCredential: async () => {
        await publishClaudeSubscriptionCredential({
          projectId,
          accountId,
          credentialId,
          home,
          identity: registered.identity,
          plan: registered.plan,
          allowedPaths: claudeSubscriptionBundlePaths(registered.payload),
        });
      },
      removeHome: async () => rm(home, { recursive: true, force: true }),
      launched,
    })
      .then(() => {
        clearTimeout(cleanupTimer);
      })
      .catch((error) => {
        stopped = undefined;
        logger.warn("Claude controller cleanup failed", error);
        if (!cleanupTimer && cleanupRetries < 5) {
          cleanupRetries++;
          cleanupTimer = setTimeout(() => {
            cleanupTimer = undefined;
            void cleanup().catch(() => {});
          }, 5000);
          cleanupTimer.unref();
        }
        throw error;
      }));
  try {
    await restoreClaudeSubscriptionHome(home, registered.payload);
    const projectPaths = await localPath({ project_id: projectId });
    const sessionDirectory = await ensureClaudeTranscriptDirectory({
      projectHome: projectPaths.home,
      accountId,
      credentialId,
    });
    cliLease = await createProjectCliTokenLease({
      projectId,
      accountId,
      agentSessionKey: JSON.stringify([
        "claude-subscription",
        projectId,
        accountId,
        credentialId,
      ]),
      home: projectPaths.home,
      scratch: projectPaths.scratch,
    });
    if (!cliLease) throw Error("Scoped Claude CLI credentials unavailable");
    const cliEnv: Record<string, string> = {
      COCALC_PROJECT_ID: projectId,
      COCALC_BEARER_TOKEN: "",
      COCALC_AGENT_TOKEN: "",
      COCALC_BEARER_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_TOKEN_FILE: cliLease.containerPath,
      COCALC_AGENT_IDENTITY_FILE: cliLease.identityContainerPath ?? "",
      COCALC_AGENT_MENTION_REFERENCES_FILE: "",
      COCALC_API_URL: resolveProjectRuntimeApiUrl(),
    };
    applyProjectRuntimeCliEnv(cliEnv, accountId);
    toolBridge = await createClaudeProjectToolBridge(
      projectId,
      (script, cwd, signal) =>
        sandboxExec({
          project_id: projectId,
          script,
          cwd,
          env: cliEnv,
          signal,
          timeoutMs: 120_000,
          maxOutputBytes: 512 * 1024,
        }),
      async () => {
        await getClaudeSubscriptionCredential({
          projectId,
          accountId,
          credentialId,
        });
      },
    );
    const owner = await harnessOwner();
    const managedHarnesses =
      process.env.COCALC_MANAGED_HARNESSES ?? MANAGED_HARNESSES;
    created = true;
    await command(
      claudeSubscriptionContainerArgs({
        name,
        projectId,
        owner,
        rootfs,
        home,
        managedHarnesses,
        nodeMounts: getNodeRuntimeMounts(),
        toolBridgeDirectory: toolBridge.directory,
        sessionDirectory,
        uid: process.getuid!(),
        gid: process.getgid!(),
        runtimeArgs: await podmanRuntimeArgs(),
      }),
    );
    launched = true;
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, "start", "--attach", "--interactive", name],
      { cwd: "/", env: podmanEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) => {
      proc.once("close", resolve);
      proc.once("error", resolve);
    });
    void closed
      .then(cleanup)
      .catch((error) =>
        logger.warn("Claude controller stopped without cleanup", error),
      );
    return {
      systemPromptAppend,
      cancelTools: () => toolBridge!.cancel(),
      resumeTools: () => toolBridge!.resume(),
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      closed,
      stop: async () => {
        try {
          await cleanup();
        } finally {
          proc.kill("SIGKILL");
          await closed;
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
