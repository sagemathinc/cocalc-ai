import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import type { executeCode as ExecuteCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "./env";
import {
  checkPodmanLaunch,
  checkPodmanLauncher,
  PODMAN_ENV_OVERRIDES_REFUSED,
  PodmanLaunchRefused,
  type PodmanLauncher,
  type PodmanLaunchPolicy,
} from "./launch-policy";

const logger = getLogger("podman");

// Loaded on first use: modules that only spawn podman (and tests that mock
// child_process) don't load execute-code and its process monitoring.
async function executeCode(
  opts: Parameters<typeof ExecuteCode>[0],
): ReturnType<typeof ExecuteCode> {
  const { executeCode } = await import("@cocalc/backend/execute-code");
  return await executeCode(opts);
}

type PodmanOpts =
  | number
  | {
      // Timeout in seconds. For backward compatibility, very large values are
      // treated as milliseconds and converted to seconds.
      timeout?: number;
      sudo?: boolean;
      launcher?: PodmanLauncher;
      // required for create, run, exec and build (see ./launch-policy.ts)
      policy?: PodmanLaunchPolicy;
    };

const DEFAULT_PODMAN_TIMEOUT_S = 30 * 60;
const STALE_PODMAN_STATE_REQUIRED_PATTERNS = ["invalid internal status"];
const STALE_PODMAN_STATE_HINT_PATTERNS = [
  "pause process",
  "podman system migrate",
  "could not find any running process",
];
const MAX_PODMAN_DEBUG_ARG_PREVIEW = 1024;
const MAX_PODMAN_DEBUG_IO_PREVIEW = 512;
const MAX_PODMAN_ERROR_ARGS = 2048;
const PODMAN_ERROR_STDERR_HEAD = 512;
const PODMAN_ERROR_STDERR_TAIL = 2048;
let migrateInFlight: Promise<void> | undefined;

function normalizeTimeoutSeconds(timeout?: number): number {
  if (timeout == null) return DEFAULT_PODMAN_TIMEOUT_S;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`invalid podman timeout: ${timeout}`);
  }
  // Historical callers sometimes passed milliseconds here; preserve behavior.
  if (timeout > 10_000) {
    return Math.max(1, Math.ceil(timeout / 1000));
  }
  return Math.ceil(timeout);
}

export default async function podman(args: string[], opts: PodmanOpts = {}) {
  const {
    timeout: rawTimeout,
    sudo,
    launcher,
    policy,
  } = typeof opts === "number"
    ? { timeout: opts, sudo: false, launcher: undefined, policy: undefined }
    : opts;
  // Every podman invocation goes through here or spawnPodman: the place that
  // refuses a launch without the gate's decision.
  checkPodmanLaunch(args, policy);
  checkPodmanLauncher(launcher);
  const timeout = normalizeTimeoutSeconds(rawTimeout);
  return await runPodman(args, timeout, Boolean(sudo), launcher, false);
}

async function runPodman(
  args: string[],
  timeout: number,
  sudo: boolean,
  launcher: PodmanLauncher | undefined,
  retried: boolean,
) {
  logger.debug(`${sudo ? "sudo " : ""}podman`, summarizePodmanInvocation(args));
  const command = launcher?.command ?? (sudo ? "sudo" : "podman");
  const cmdArgs = launcher
    ? [...launcher.argsPrefix, ...args]
    : sudo
      ? ["podman", ...args]
      : args;
  try {
    const x = await executeCode({
      verbose: false,
      command,
      args: cmdArgs,
      env: podmanEnv(),
      err_on_exit: false,
      timeout,
    });
    if (x.exit_code !== 0) {
      if (!retried && isStalePodmanStateResult(x)) {
        logger.warn(
          "podman reported stale pause-process state; running `podman system migrate` and retrying once",
        );
        await repairStalePodmanState(timeout, sudo);
        return await runPodman(args, timeout, sudo, launcher, true);
      }
      throw formatPodmanExitError(command, cmdArgs, x.exit_code, x.stderr);
    }
    logger.debug("podman returned", summarizePodmanResult(x));
    return x;
  } catch (err) {
    logger.debug("podman run error", { err: `${err}` });
    throw err;
  }
}

/**
 * Spawn podman (streaming callers). Like podman(): create, run, exec and
 * build need the launch gate's policy. env is merged over podmanEnv().
 */
export function spawnPodman(
  args: string[],
  opts: SpawnOptions & {
    launcher?: PodmanLauncher;
    policy?: PodmanLaunchPolicy;
  } = {},
): ChildProcess {
  const { launcher, policy, env, ...spawnOptions } = opts;
  checkPodmanLaunch(args, policy);
  checkPodmanLauncher(launcher);
  refuseEnvOverrides(env);
  const command = launcher?.command ?? "podman";
  const cmdArgs = launcher ? [...launcher.argsPrefix, ...args] : args;
  return spawn(command, cmdArgs, {
    ...spawnOptions,
    env: { ...podmanEnv(), ...(env ?? {}) },
  });
}

/**
 * executeCode for podman: the same options (timeout in seconds, err_on_exit,
 * ...) and result, with podman's environment and the launch rules.
 */
export async function executePodman(
  args: string[],
  opts: {
    timeout?: number;
    err_on_exit?: boolean;
    verbose?: boolean;
    cwd?: string;
    sudo?: boolean;
    launcher?: PodmanLauncher;
    policy?: PodmanLaunchPolicy;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const { sudo, launcher, policy, env, verbose = false, ...rest } = opts;
  checkPodmanLaunch(args, policy);
  checkPodmanLauncher(launcher);
  refuseEnvOverrides(env);
  const command = launcher?.command ?? (sudo ? "sudo" : "podman");
  const cmdArgs = launcher
    ? [...launcher.argsPrefix, ...args]
    : sudo
      ? ["podman", ...args]
      : args;
  return await executeCode({
    ...rest,
    verbose,
    command,
    args: cmdArgs,
    env: { ...podmanEnv(), ...(env ?? {}) },
  });
}

/** spawnPodman with all three stdio streams piped. */
export function spawnPodmanPiped(
  args: string[],
  opts: Omit<Parameters<typeof spawnPodman>[1], "stdio"> = {},
): ChildProcessWithoutNullStreams {
  return spawnPodman(args, {
    ...opts,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

// containers.conf and friends can set the user namespace: not from callers
function refuseEnvOverrides(env: NodeJS.ProcessEnv | undefined): void {
  if (env == null) return;
  const own = podmanEnv();
  for (const key of PODMAN_ENV_OVERRIDES_REFUSED) {
    if (env[key] !== undefined && env[key] !== own[key]) {
      throw new PodmanLaunchRefused(
        "env-override",
        `podman: ${key} can't be set by the caller`,
      );
    }
  }
}

/**
 * execFile for podman, for callers whose arguments must not be logged (they
 * carry secrets): nothing about args is logged here. Same launch rules as
 * podman(); env is merged over podmanEnv().
 */
export function execFilePodman(
  args: string[],
  opts: ExecFileOptions & {
    launcher?: PodmanLauncher;
    policy?: PodmanLaunchPolicy;
  },
  callback: (
    error:
      | (Error & { code?: unknown; killed?: boolean; signal?: unknown })
      | null,
    stdout: string,
    stderr: string,
  ) => void,
): ChildProcess {
  const { launcher, policy, env, ...execOptions } = opts;
  checkPodmanLaunch(args, policy);
  checkPodmanLauncher(launcher);
  refuseEnvOverrides(env);
  const command = launcher?.command ?? "podman";
  const cmdArgs = launcher ? [...launcher.argsPrefix, ...args] : args;
  return execFile(
    command,
    cmdArgs,
    {
      ...execOptions,
      encoding: "utf8",
      env: { ...podmanEnv(), ...(env ?? {}) },
    },
    (error, stdout, stderr) =>
      callback(error as any, `${stdout ?? ""}`, `${stderr ?? ""}`),
  );
}

function summarizePodmanInvocation(args: string[]) {
  const joined = args.join(" ");
  return {
    argc: args.length,
    preview: truncate(joined, MAX_PODMAN_DEBUG_ARG_PREVIEW),
  };
}

function summarizePodmanResult(result: {
  type?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}) {
  const stdout = `${result.stdout ?? ""}`;
  const stderr = `${result.stderr ?? ""}`;
  return {
    type: result.type,
    exit_code: result.exit_code,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_preview: stdout ? truncate(stdout, MAX_PODMAN_DEBUG_IO_PREVIEW) : "",
    stderr_preview: stderr ? truncate(stderr, MAX_PODMAN_DEBUG_IO_PREVIEW) : "",
  };
}

function formatPodmanExitError(
  command: string,
  args: string[],
  exitCode: number,
  stderr: string,
): string {
  // Podman and crun print the cause last, and the logger cuts strings at
  // 10000 characters, so long argument lists are shortened and stderr keeps
  // its start and its end.
  const joined = truncate(args.join(" "), MAX_PODMAN_ERROR_ARGS);
  const x =
    command === "sudo"
      ? `'podman' (args=${joined})`
      : `'${command}' (args=${joined})`;
  return `command '${x}' exited with nonzero code ${exitCode} -- stderr='${headAndTail(stderr, PODMAN_ERROR_STDERR_HEAD, PODMAN_ERROR_STDERR_TAIL)}'`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function headAndTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}…[${omitted} characters omitted]…${text.slice(-tail)}`;
}

function isStalePodmanStateResult(result: {
  stderr?: string;
  stdout?: string;
}): boolean {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const normalized = text.toLowerCase();
  return (
    STALE_PODMAN_STATE_REQUIRED_PATTERNS.every((pattern) =>
      normalized.includes(pattern),
    ) &&
    STALE_PODMAN_STATE_HINT_PATTERNS.some((pattern) =>
      normalized.includes(pattern),
    )
  );
}

async function repairStalePodmanState(
  timeout: number,
  sudo: boolean,
): Promise<void> {
  if (!migrateInFlight) {
    migrateInFlight = (async () => {
      const command = sudo ? "sudo" : "podman";
      const args = sudo
        ? ["podman", "system", "migrate"]
        : ["system", "migrate"];
      try {
        await executeCode({
          verbose: false,
          command,
          args,
          env: podmanEnv(),
          err_on_exit: true,
          timeout,
        });
      } finally {
        migrateInFlight = undefined;
      }
    })();
  }
  await migrateInFlight;
}
