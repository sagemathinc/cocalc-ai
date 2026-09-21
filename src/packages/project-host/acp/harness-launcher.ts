import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HarnessBinding, HarnessProcess } from "@cocalc/ai/acp/harness";
import { parseAcpHarnessProfile } from "@cocalc/util/ai/runtime";
import { isValidUUID } from "@cocalc/util/misc";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { mountArg } from "@cocalc/backend/podman";
import { localPath } from "@cocalc/project-runner/run/filesystem";
import {
  getImageNamePath,
  mount,
  unmount,
} from "@cocalc/project-runner/run/rootfs";
import { getEnvironment } from "@cocalc/project-runner/run/env";
import { getCoCalcMounts } from "@cocalc/project-runner/run/mounts";
import {
  podmanRuntimeArgs,
  projectPoolPodmanLauncher,
} from "@cocalc/project-runner/run/podman";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_GID,
} from "@cocalc/util/project-runtime";
import { ensureProjectContainerRunning } from "../codex/codex-project";
import { getProject } from "../sqlite/projects";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:acp:harness-launcher");

/** Internal worker launcher. Admission must authorize the principal before calling. */
export async function launchHarnessInProject(
  binding: HarnessBinding,
): Promise<HarnessProcess> {
  const { projectId, accountId } = binding;
  const profile = parseAcpHarnessProfile(binding.profile);
  if (
    !isValidUUID(projectId) ||
    !isValidUUID(accountId) ||
    !getProject(projectId)
  )
    throw Error("ACP project is not available on this host");
  await ensureProjectContainerRunning({ projectId, accountId });
  const launcher = projectPoolPodmanLauncher(projectId);
  // Never log arguments: image/project-managed configuration may contain secrets.
  const command = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        launcher.command,
        [...launcher.argsPrefix, ...args],
        {
          cwd: "/",
          env: podmanEnv(),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error) =>
          error ? reject(Error("ACP container operation failed")) : resolve(),
      );
    });
  const { home, scratch } = await localPath({ project_id: projectId });
  const image = (await readFile(getImageNamePath(home), "utf8")).trim();
  const env = await getEnvironment({
    project_id: projectId,
    HOME: DEFAULT_PROJECT_RUNTIME_HOME,
    image,
  });
  const rootfs = await mount({
    project_id: projectId,
    home,
    config: { image },
  });
  const name = `acp-${projectId}-${randomUUID()}`;
  let created = false;
  let stopped: Promise<void> | undefined;
  const cleanup = () =>
    (stopped ??= (async () => {
      // Keep the rootfs lease if removal fails; never unmount beneath a live child.
      if (created)
        await command(["rm", "--ignore", "--force", "--time", "0", name]);
      await unmount(projectId);
    })());
  try {
    const args = [
      "create",
      ...(await podmanRuntimeArgs()),
      "--cgroups=disabled",
      "--interactive",
      "--name",
      name,
      "--label",
      "cocalc.runtime=acp",
      "--label",
      `cocalc.project=${projectId}`,
      `--userns=keep-id:uid=${DEFAULT_PROJECT_RUNTIME_UID},gid=${DEFAULT_PROJECT_RUNTIME_GID}`,
      "--user",
      `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
      // Preserve the project's existing network policy, not a new unrestricted network.
      `--network=container:project-${projectId}`,
      "--workdir",
      profile.cwd,
      mountArg({ source: home, target: DEFAULT_PROJECT_RUNTIME_HOME }),
    ];
    if (scratch) args.push(mountArg({ source: scratch, target: "/tmp" }));
    for (const [source, target] of Object.entries(getCoCalcMounts()))
      args.push(mountArg({ source, target, readOnly: true }));
    for (const [key, value] of Object.entries(env))
      args.push("--env", `${key}=${value}`);
    args.push("--rootfs", rootfs, profile.executable, ...profile.args);
    // Mark before awaiting: timeout/disconnect can leave a successfully created container.
    created = true;
    await command(args);
    const proc = spawn(
      launcher.command,
      [...launcher.argsPrefix, "start", "--attach", "--interactive", name],
      {
        cwd: "/",
        env: podmanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = new Promise<void>((resolve) => {
      proc.once("close", resolve);
      proc.once("error", resolve);
    });
    // Process exit also terminates surviving children in the isolated PID namespace.
    void closed.then(cleanup).catch(() => {
      logger.warn("ACP container cleanup failed", { projectId, name });
    });
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
