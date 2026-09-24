/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { mountArg } from "@cocalc/backend/podman";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { isValidUUID } from "@cocalc/util/misc";
import { getNodeRuntimeMounts } from "@cocalc/project-runner/run/mounts";
import {
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

const CONTROLLER_HOME = "/home/claude";
const CONTROLLER_WORKSPACE = "/workspace";
const MANAGED_HARNESSES = "/opt/cocalc/harnesses";
const logger = getLogger("project-host:acp:claude-subscription-controller");

export function claudeSubscriptionContainerArgs(options: {
  name: string;
  rootfs: string;
  home: string;
  managedHarnesses: string;
  nodeMounts: Record<string, string>;
  uid: number;
  gid: number;
  runtimeArgs?: string[];
}): string[] {
  const {
    name,
    rootfs,
    home,
    managedHarnesses,
    nodeMounts,
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
    `${CONTROLLER_WORKSPACE}:mode=0700`,
    "--tmpfs",
    "/tmp:mode=0700",
    mountArg({ source: home, target: CONTROLLER_HOME }),
    mountArg({
      source: managedHarnesses,
      target: MANAGED_HARNESSES,
      readOnly: true,
    }),
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
  const home = await mkdtemp(join(tmpdir(), "cocalc-claude-controller-"));
  const launcher = projectPoolPodmanLauncher(projectId);
  const name = `claude-controller-${projectId}-${randomUUID()}`;
  let created = false;
  let stopped: Promise<void> | undefined;
  const command = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.argsPrefix, ...args],
        { cwd: "/", env: podmanEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error) =>
          error
            ? reject(Error("Claude controller operation failed"))
            : resolve(),
      );
    });
  const cleanup = () =>
    (stopped ??= (async () => {
      if (created)
        await command(["rm", "--ignore", "--force", "--time", "0", name]);
      await publishClaudeSubscriptionCredential({
        projectId,
        accountId,
        credentialId,
        home,
        identity: registered.identity,
        plan: registered.plan,
        allowedPaths: claudeSubscriptionBundlePaths(registered.payload),
      });
      await rm(home, { recursive: true, force: true });
    })().catch((error) => {
      stopped = undefined;
      logger.warn("Claude controller cleanup failed", error);
      throw error;
    }));
  try {
    await restoreClaudeSubscriptionHome(home, registered.payload);
    const rootfs = await extractBaseImage(DEFAULT_PROJECT_IMAGE);
    const managedHarnesses =
      process.env.COCALC_MANAGED_HARNESSES ?? MANAGED_HARNESSES;
    created = true;
    await command(
      claudeSubscriptionContainerArgs({
        name,
        rootfs,
        home,
        managedHarnesses,
        nodeMounts: getNodeRuntimeMounts(),
        uid: process.getuid!(),
        gid: process.getgid!(),
        runtimeArgs: await podmanRuntimeArgs(),
      }),
    );
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
        await cleanup();
        proc.kill("SIGKILL");
        await closed;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
