import {
  type ExecuteCodeOptions,
  type ExecuteCodeOutputBlocking,
  type ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { stat } from "node:fs/promises";

const logger = getLogger("file-server:storage:util");

const DEFAULT_EXEC_TIMEOUT_MS = 60 * 1000;
export const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const DIRECT_SUDO_FALLBACK_MESSAGE =
  "runtime storage wrapper unavailable; using direct sudo fallback";

function envEnabled(name: string): boolean {
  const raw = `${process.env[name] ?? ""}`.trim().toLowerCase();
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw);
}

function directFallbackAllowed(): boolean {
  return envEnabled("COCALC_RUNTIME_STORAGE_ALLOW_DIRECT") || process.env.NODE_ENV === "test";
}

function wrapperEnabled(): boolean {
  const raw = process.env.COCALC_RUNTIME_STORAGE_WRAPPER;
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off", "none", "direct"].includes(normalized);
}

function wrapperPath(): string {
  const raw = process.env.COCALC_RUNTIME_STORAGE_WRAPPER;
  if (!raw) return STORAGE_WRAPPER;
  return raw.trim();
}

function maybeMissingWrapper(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes("command not found") ||
    s.includes("no such file or directory") ||
    s.includes("not found")
  );
}

function throwOnExit(
  command: string,
  args: string[],
  result: ExecuteCodeOutputBlocking,
): never {
  throw new Error(
    `command '${command}' (args=${args.join(" ")}) exited with nonzero code ${result.exit_code} -- stderr='${result.stderr}'`,
  );
}

async function runSudo(
  opts: ExecuteCodeOptions,
  args: string[],
): Promise<ExecuteCodeOutputBlocking> {
  return (await executeCode({
    verbose: true,
    timeout: DEFAULT_EXEC_TIMEOUT_MS / 1000,
    ...opts,
    err_on_exit: false,
    command: "sudo",
    args: ["-n", ...args],
    // LC_ALL, etc. so that btrfs output we parse is not in a different language!
    env: { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" },
  })) as ExecuteCodeOutputBlocking;
}

export async function mkdirp(paths: string[]) {
  if (paths.length == 0) return;
  await sudo({ command: "mkdir", args: ["-p", ...paths] });
}

export async function sudo(
  opts: ExecuteCodeOptions & { desc?: string },
): Promise<ExecuteCodeOutput> {
  if (opts.verbose !== false && opts.desc) {
    logger.debug("exec", opts.desc);
  }
  if ((opts as any).bash) {
    throw new Error(
      "file-server:btrfs sudo bash mode is disabled; use wrapper command args",
    );
  }
  const strictErrOnExit = opts.err_on_exit ?? true;
  const directArgs = [opts.command, ...(opts.args ?? [])];

  if (!wrapperEnabled()) {
    const direct = await runSudo(opts, directArgs);
    if (strictErrOnExit && direct.exit_code !== 0) {
      throwOnExit("sudo", ["-n", ...directArgs], direct);
    }
    return direct;
  }

  const wrappedArgs = [wrapperPath(), ...directArgs];
  const wrapped = await runSudo(opts, wrappedArgs);
  if (wrapped.exit_code === 0) {
    return wrapped;
  }

  if (
    directFallbackAllowed() &&
    maybeMissingWrapper(wrapped.stderr) &&
    wrapped.stderr.includes(wrapperPath())
  ) {
    logger.warn(DIRECT_SUDO_FALLBACK_MESSAGE, {
      wrapper: wrapperPath(),
      command: opts.command,
    });
    const direct = await runSudo(opts, directArgs);
    if (strictErrOnExit && direct.exit_code !== 0) {
      throwOnExit("sudo", ["-n", ...directArgs], direct);
    }
    return direct;
  }

  if (strictErrOnExit) {
    throwOnExit("sudo", ["-n", ...wrappedArgs], wrapped);
  }
  return wrapped;
}

export async function btrfs(
  opts: Partial<ExecuteCodeOptions & { desc?: string }>,
) {
  return await sudo({ ...opts, command: "btrfs" });
}

export async function isDir(path: string) {
  return (await stat(path)).isDirectory();
}

export function parseBupTime(s: string): Date {
  const [year, month, day, time] = s.split("-");
  const hours = time.slice(0, 2);
  const minutes = time.slice(2, 4);
  const seconds = time.slice(4, 6);

  return new Date(
    Number(year),
    Number(month) - 1, // JS months are 0-based
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
}

export async function ensureMoreLoopbackDevices() {
  // to run tests, this is helpful
  //for i in $(seq 8 63); do sudo mknod -m660 /dev/loop$i b 7 $i; sudo chown root:disk /dev/loop$i; done
  for (let i = 0; i < 64; i++) {
    try {
      await stat(`/dev/loop${i}`);
      continue;
    } catch {}
    try {
      // also try/catch this because ensureMoreLoops happens in parallel many times at once...
      await sudo({
        command: "mknod",
        args: ["-m660", `/dev/loop${i}`, "b", "7", `${i}`],
      });
    } catch {}
    await sudo({ command: "chown", args: ["root:disk", `/dev/loop${i}`] });
  }
}
