/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { mountArg } from "@cocalc/backend/podman";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { parseConmonContainerProcessLists } from "@cocalc/backend/podman/conmon";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { normalizeRootfsImageName } from "@cocalc/util/rootfs-images";
import { isValidUUID } from "@cocalc/util/misc";
import { extractBaseImage } from "@cocalc/project-runner/run/rootfs-base";
import {
  podmanRuntimeArgs,
  projectPoolPodmanLauncher,
} from "@cocalc/project-runner/run/podman";

const exec = promisify(execFile);
const MOUNT = "/opt/cocalc/harnesses";
const HOME = "/home/claude";

export interface ClaudeLoginRuntimeBinding {
  projectId: string;
  holder: string;
  home: string;
  runtimeId: string;
}

export interface ClaudeLoginRuntime {
  launch(binding: ClaudeLoginRuntimeBinding): Promise<ChildProcess>;
  status(binding: ClaudeLoginRuntimeBinding): Promise<string>;
  stop(binding: ClaudeLoginRuntimeBinding): Promise<void>;
}

export function claudeLoginContainerName(
  binding: Pick<ClaudeLoginRuntimeBinding, "projectId" | "holder">,
  phase: "login" | "status",
): string {
  if (![binding.projectId, binding.holder].every(isValidUUID))
    throw Error("Invalid Claude sign-in containment binding");
  return `claude-sign-in-${binding.projectId}-${binding.holder}-${phase}`;
}

export function claudeLoginContainerArgs(options: {
  binding: ClaudeLoginRuntimeBinding;
  phase: "login" | "status";
  rootfs: string;
  managedHarnesses: string;
  cliRelativePath: string;
  runtimeArgs: string[];
  uid: number;
  gid: number;
}): string[] {
  const {
    binding,
    phase,
    rootfs,
    managedHarnesses,
    cliRelativePath,
    runtimeArgs,
    uid,
    gid,
  } = options;
  if (
    !cliRelativePath ||
    cliRelativePath.startsWith("/") ||
    cliRelativePath.split("/").includes("..")
  )
    throw Error("Invalid managed Claude CLI path");
  return [
    "create",
    ...runtimeArgs,
    "--name",
    claudeLoginContainerName(binding, phase),
    "--label",
    "cocalc.runtime=claude-sign-in",
    "--label",
    `cocalc.acp.owner=${binding.runtimeId}`,
    "--label",
    `cocalc.project=${binding.projectId}`,
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
    HOME,
    "--tmpfs",
    "/tmp:mode=1777",
    // Recovery/ownership records stay in the parent, outside the native mount.
    mountArg({ source: join(binding.home, "native"), target: HOME }),
    mountArg({ source: managedHarnesses, target: MOUNT, readOnly: true }),
    ...[
      `HOME=${HOME}`,
      `CLAUDE_CONFIG_DIR=${HOME}`,
      `XDG_CONFIG_HOME=${HOME}`,
      "NO_BROWSER=1",
      "LANG=C.UTF-8",
      "PATH=/usr/bin:/bin",
    ].flatMap((value) => ["--env", value]),
    "--rootfs",
    rootfs,
    `${MOUNT}/${cliRelativePath}`,
    "auth",
    ...(phase === "login" ? ["login", "--claudeai"] : ["status", "--json"]),
  ];
}

async function command(
  projectId: string | undefined,
  args: string[],
  maxBuffer = 16 * 1024,
): Promise<string> {
  const launcher = projectId
    ? projectPoolPodmanLauncher(projectId)
    : { command: "podman", argsPrefix: [] };
  try {
    return (
      await exec(launcher.command, [...launcher.argsPrefix, ...args], {
        cwd: "/",
        env: podmanEnv(),
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer,
      })
    ).stdout;
  } catch {
    // Native stdout/stderr may contain sign-in URLs or provider output.
    throw Error("Claude sign-in container operation failed");
  }
}

/** Removal of both PID namespaces, not process labels, proves native shutdown. */
export async function stopClaudeLoginContainers(
  binding: Pick<ClaudeLoginRuntimeBinding, "projectId" | "holder">,
): Promise<void> {
  const names = (["login", "status"] as const).map((phase) =>
    claudeLoginContainerName(binding, phase),
  );
  for (const name of names)
    await command(undefined, [
      "rm",
      "--ignore",
      "--force",
      "--time",
      "0",
      name,
    ]);
  // An absent Podman row alone is insufficient if an orphaned conmon still runs.
  const snapshot = await exec("ps", ["-eo", "pid=,ppid=,args="], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => {
    throw Error("Claude sign-in shutdown inventory is unconfirmed");
  });
  const live = parseConmonContainerProcessLists(snapshot.stdout);
  if (names.some((name) => live.has(name)))
    throw Error("Claude sign-in shutdown is unconfirmed");
}

export function createClaudeLoginRuntime(cliPath: string): ClaudeLoginRuntime {
  const managedHarnesses = resolve(
    process.env.COCALC_MANAGED_HARNESSES ?? MOUNT,
  );
  const cliRelativePath = relative(managedHarnesses, resolve(cliPath));
  const create = async (
    binding: ClaudeLoginRuntimeBinding,
    phase: "login" | "status",
  ) => {
    const rootfs = await extractBaseImage(
      normalizeRootfsImageName(DEFAULT_PROJECT_IMAGE),
    );
    await command(
      binding.projectId,
      claudeLoginContainerArgs({
        binding,
        phase,
        rootfs,
        managedHarnesses,
        cliRelativePath,
        runtimeArgs: await podmanRuntimeArgs(),
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    );
  };
  return {
    async launch(binding) {
      // Deliberately separate create from start: a late create after worker death
      // cannot run native auth, and a late start cannot recreate a removed name.
      await create(binding, "login");
      const launcher = projectPoolPodmanLauncher(binding.projectId);
      return spawn(
        launcher.command,
        [
          ...launcher.argsPrefix,
          "start",
          "--attach",
          "--interactive",
          claudeLoginContainerName(binding, "login"),
        ],
        {
          cwd: "/",
          env: podmanEnv(),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    },
    async status(binding) {
      await stopClaudeLoginContainers(binding);
      try {
        await create(binding, "status");
        return await command(binding.projectId, [
          "start",
          "--attach",
          claudeLoginContainerName(binding, "status"),
        ]);
      } finally {
        await stopClaudeLoginContainers(binding);
      }
    },
    stop: stopClaudeLoginContainers,
  };
}
