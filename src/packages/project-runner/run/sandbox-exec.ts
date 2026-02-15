import { execFile } from "node:child_process";
import getLogger from "@cocalc/backend/logger";
import { argsJoin } from "@cocalc/util/args";
import { localPath } from "./filesystem";
import { getImageNamePath, mount as mountRootFs, unmount } from "./rootfs";
import { readFile } from "fs/promises";
import { networkArgument } from "./podman";
import { mountArg } from "@cocalc/backend/podman";
import { getEnvironment } from "./env";
import { join } from "node:path";
import { getCoCalcMounts } from "./mounts";

export interface SandboxExecOptions {
  project_id: string;
  script: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * When true, start a fresh one-off container instead of exec'ing into the
   * existing project container. This is useful when the main container is not
   * running or when we want to mount the workspace at a different host path
   * (e.g., to avoid path rewriting).
   * NOTE: the project must have been run at least once on the project host
   * or we don't have sufficient information to run it and there will be an error.
   */
  useEphemeral?: boolean;

  /** Optionally disable network for ephemeral runs */
  noNetwork?: boolean;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
}

const logger = getLogger("project-runner:sandbox-exec");

function hasExplicitNetworkOverride(): boolean {
  return !!`${process.env.COCALC_PROJECT_RUNNER_NETWORK ?? ""}`.trim();
}

function allowNetworkFallback(): boolean {
  const raw = `${process.env.COCALC_PROJECT_RUNNER_NETWORK_FALLBACK ?? "true"}`
    .trim()
    .toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function slirpNetworkArgument(): string {
  const allowHostLoopbackRaw = `${process.env.COCALC_PROJECT_RUNNER_ALLOW_HOST_LOOPBACK ?? "true"}`
    .trim()
    .toLowerCase();
  const allowHostLoopback = !(
    allowHostLoopbackRaw === "0" ||
    allowHostLoopbackRaw === "false" ||
    allowHostLoopbackRaw === "no"
  );
  return allowHostLoopback
    ? "--network=slirp4netns:allow_host_loopback=true"
    : "--network=slirp4netns";
}

// this will fail if never run on this project host, as documented above.
async function getContainerImage(home: string): Promise<string> {
  return (await readFile(getImageNamePath(home))).toString().trim();
}

/**
 * Run a shell script inside an existing project container.
 *
 * This mirrors the behavior of the container executor used by ACP:
 * - By default executes inside `project-${project_id}` with podman exec.
 * - When useEphemeral is true, starts a one-off container (podman run --rm)
 *   using the same image as the project container.
 * - Uses /bin/bash -lc to run the provided script
 * - Allows a custom cwd inside the container
 * - Captures stdout/stderr/exit code
 *
 * Note: Environment is not propagated from the host; callers should expand any
 * needed env directly into the script if required.
 */
export async function sandboxExec({
  project_id,
  script,
  cwd,
  timeoutMs,
  useEphemeral,
  noNetwork,
}: SandboxExecOptions): Promise<SandboxExecResult> {
  logger.debug("sandboxExec", {
    project_id,
    useEphemeral,
    cwd,
    script,
    timeoutMs,
  });
  const args: string[] = [];
  const HOME = "/root";
  const getWorkdir = () => {
    if (cwd?.startsWith("/")) {
      return cwd;
    } else {
      return cwd ? join(HOME, cwd) : HOME;
    }
  };

  const runPodman = async (args: string[]): Promise<SandboxExecResult> => {
    return await new Promise((resolve) => {
      execFile(
        "podman",
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: "SIGKILL",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error: any, stdout?: string, stderr?: string) => {
          if (error) {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? error?.message ?? "",
              code: typeof error?.code === "number" ? error.code : null,
              signal: error?.signal,
            });
          } else {
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
          }
        },
      );
    });
  };

  let rootfs: string | undefined;
  let selectedNetwork: string | undefined;
  let networkArgIndex: number | undefined;
  try {
    if (useEphemeral) {
      const { home, scratch } = await localPath({
        project_id,
      });
      const image = await getContainerImage(home);
      const env = await getEnvironment({
        project_id,
        HOME,
        image,
      });

      // Build a one-off container run.
      args.push("run", "--runtime", "/usr/bin/crun", "--rm", "-i");
      args.push("--security-opt", "no-new-privileges");
      // execFile timeout still applies; podman itself doesn't have a timeout flag.
      if (!noNetwork) {
        selectedNetwork = networkArgument();
        networkArgIndex = args.length;
        args.push(selectedNetwork);
      }
      args.push("--workdir", getWorkdir());

      for (const key in env) {
        args.push("-e", `${key}=${env[key]}`);
      }

      args.push(mountArg({ source: home, target: HOME }));
      if (scratch) {
        args.push(mountArg({ source: scratch, target: "/scratch" }));
      }
      const mounts = getCoCalcMounts();
      for (const path in mounts) {
        args.push(
          mountArg({ source: path, target: mounts[path], readOnly: true }),
        );
      }

      // Name the container for easier debugging; allow reuse without conflicts.
      args.push("--name", `sandbox-${project_id}-${Date.now()}`);

      rootfs = await mountRootFs({ project_id, home, config: { image } });
      args.push("--rootfs", rootfs);
      args.push("/bin/bash", "-lc", script);
    } else {
      args.push(
        "exec",
        "-i",
        "--workdir",
        getWorkdir(),
        `project-${project_id}`,
        "/bin/bash",
        "-lc",
        script,
      );
    }

    logger.debug("podman", argsJoin(args));
    let result = await runPodman(args);
    const canFallback =
      useEphemeral &&
      !noNetwork &&
      !!selectedNetwork &&
      selectedNetwork.startsWith("--network=pasta") &&
      !hasExplicitNetworkOverride() &&
      allowNetworkFallback() &&
      networkArgIndex != null;
    if (canFallback && result.code !== 0) {
      const fallbackNetwork = slirpNetworkArgument();
      logger.warn(
        "sandbox-exec podman run failed with pasta; retrying with slirp4netns fallback",
        {
          project_id,
          selectedNetwork,
          fallbackNetwork,
          code: result.code,
          stderr: result.stderr,
        },
      );
      if (networkArgIndex != null) {
        args[networkArgIndex] = fallbackNetwork;
        result = await runPodman(args);
      }
    }
    return result;
  } finally {
    if (rootfs) {
      // Decrement overlay mount refcount; actual unmount happens only when
      // no other users (e.g., the main project container) are using it.
      await unmount(project_id);
    }
  }
}
