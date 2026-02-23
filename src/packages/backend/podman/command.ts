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
    throw err;
  }
}
