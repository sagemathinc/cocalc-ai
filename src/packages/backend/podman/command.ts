import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "./env";

const logger = getLogger("podman");

type PodmanOpts =
  | number
  | {
      // Timeout in seconds. For backward compatibility, very large values are
      // treated as milliseconds and converted to seconds.
      timeout?: number;
      sudo?: boolean;
      launcher?: {
        command: string;
        argsPrefix: string[];
      };
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
  } = typeof opts === "number"
    ? { timeout: opts, sudo: false, launcher: undefined }
    : opts;
  const timeout = normalizeTimeoutSeconds(rawTimeout);
  return await runPodman(args, timeout, Boolean(sudo), launcher, false);
}

async function runPodman(
  args: string[],
  timeout: number,
  sudo: boolean,
  launcher: { command: string; argsPrefix: string[] } | undefined,
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
