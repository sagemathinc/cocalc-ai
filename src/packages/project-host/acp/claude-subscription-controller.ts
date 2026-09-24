/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { mountArg } from "@cocalc/backend/podman";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { normalizeRootfsImageName } from "@cocalc/util/rootfs-images";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { getNodeRuntimeMounts } from "@cocalc/project-runner/run/mounts";
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
import { ensureProjectContainerRunning } from "../codex/codex-project";
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

export async function cleanupClaudeSubscriptionController(options: {
  stopContainer: () => Promise<void>;
  closeBridge: () => Promise<void>;
  refreshCredential: () => Promise<void>;
  removeHome: () => Promise<void>;
  launched: boolean;
}): Promise<void> {
  await options.stopContainer();
  try {
    await options.closeBridge();
    if (options.launched) await options.refreshCredential();
  } finally {
    await options.removeHome();
  }
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
      mountArg({ source, target, readOnly: true }),
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
  let stopped: Promise<void> | undefined;
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
      closeBridge: async () => toolBridge?.close(),
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
    }).catch((error) => {
      stopped = undefined;
      logger.warn("Claude controller cleanup failed", error);
      throw error;
    }));
  try {
    await restoreClaudeSubscriptionHome(home, registered.payload);
    toolBridge = await createClaudeProjectToolBridge(
      projectId,
      undefined,
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
