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
    };

const DEFAULT_PODMAN_TIMEOUT_S = 30 * 60;
const STALE_PODMAN_STATE_PATTERNS = [
  "invalid internal status",
  'try resetting the pause process with "podman system migrate"',
  "could not find any running process",
];
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
  const { timeout: rawTimeout, sudo } =
    typeof opts === "number" ? { timeout: opts, sudo: false } : opts;
  const timeout = normalizeTimeoutSeconds(rawTimeout);
  return await runPodman(args, timeout, Boolean(sudo), false);
}

async function runPodman(
  args: string[],
  timeout: number,
  sudo: boolean,
  retried: boolean,
) {
  logger.debug(`${sudo ? "sudo " : ""}podman `, args.join(" "));
  const command = sudo ? "sudo" : "podman";
  const cmdArgs = sudo ? ["podman", ...args] : args;
  try {
    const x = await executeCode({
      verbose: false,
      command,
      args: cmdArgs,
      env: podmanEnv(),
      err_on_exit: true,
      timeout,
    });
    logger.debug("podman returned ", x);
    return x;
  } catch (err) {
    logger.debug("podman run error: ", err);
    if (!retried && isStalePodmanStateError(err)) {
      logger.warn(
        "podman reported stale pause-process state; running `podman system migrate` and retrying once",
      );
      await repairStalePodmanState(timeout, sudo);
      return await runPodman(args, timeout, sudo, true);
    }
    throw err;
  }
}

function isStalePodmanStateError(err: unknown): boolean {
  const text =
    err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const normalized = text.toLowerCase();
  return STALE_PODMAN_STATE_PATTERNS.every((pattern) =>
    normalized.includes(pattern),
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
