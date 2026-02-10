import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv, type PodmanEnvOptions } from "./env";
import os from "node:os";

const logger = getLogger("podman");

export type PodmanOpts =
  | number
  | {
      timeout?: number;
      sudo?: boolean;
      sudoUser?: string;
      runAsUser?: string;
    };

export type PodmanCommandSpec = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
};

function currentUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME;
  }
}

function normalizeOptions(
  opts: PodmanOpts,
): {
  timeout?: number;
  sudo?: boolean;
  sudoUser?: string;
  runAsUser?: string;
} {
  if (typeof opts === "number") {
    return { timeout: opts, sudo: false };
  }
  return opts ?? {};
}

export function buildPodmanCommand(
  args: string[],
  opts: { sudo?: boolean; sudoUser?: string; runAsUser?: string } = {},
): PodmanCommandSpec {
  const { sudo, sudoUser, runAsUser } = normalizeOptions(opts);
  const envOpts: PodmanEnvOptions = { runAsUser };
  const env = podmanEnv(envOpts);
  const requestedUser = runAsUser ?? process.env.COCALC_PODMAN_RUN_AS_USER;
  const current = currentUserName();

  if (sudo) {
    const userArgs = sudoUser ? ["-u", sudoUser, "-H"] : [];
    const sudoArgs = [
      "-n",
      ...userArgs,
      "--preserve-env=XDG_RUNTIME_DIR,CONTAINERS_CGROUP_MANAGER",
      "podman",
      ...args,
    ];
    return { command: "sudo", args: sudoArgs, env };
  }

  if (requestedUser && requestedUser !== current) {
    const sudoArgs = [
      "-n",
      "-u",
      requestedUser,
      "-H",
      "--preserve-env=XDG_RUNTIME_DIR,CONTAINERS_CGROUP_MANAGER",
      "podman",
      ...args,
    ];
    return { command: "sudo", args: sudoArgs, env };
  }

  return { command: "podman", args, env };
}

// 30 minute timeout (?)
export default async function podman(args: string[], opts: PodmanOpts = {}) {
  const { timeout, sudo, sudoUser, runAsUser } = normalizeOptions(opts);
  const spec = buildPodmanCommand(args, { sudo, sudoUser, runAsUser });
  logger.debug(`${spec.command} `, spec.args.join(" "));
  try {
    const x = await executeCode({
      verbose: false,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      err_on_exit: true,
      timeout: timeout ?? 30 * 60 * 1000,
    });
    logger.debug("podman returned ", x);
    return x;
  } catch (err) {
    logger.debug("podman run error: ", err);
    throw err;
  }
}
