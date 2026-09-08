import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { type ExecOutput } from "@cocalc/conat/files/fs";
export { type ExecOutput };
import getLogger from "@cocalc/backend/logger";
import { posix } from "node:path";

const logger = getLogger("files:sandbox:exec");

const DEFAULT_TIMEOUT = 3_000;
const DEFAULT_MAX_SIZE = 10_000_000;

export interface Options {
  // the path to the command
  cmd: string;
  // position args *before* any options; these are not sanitized
  prefixArgs?: string[];
  // positional arguments; these are not sanitized, but are given after '--' for safety
  positionalArgs?: string[];
  // whitelisted args flags; these are checked according to the whitelist specified below
  options?: string[];
  // if given, use these options when os.platform()=='darwin' (i.e., macOS); these must match whitelist
  darwin?: string[];
  // if given, use these options when os.platform()=='linux'; these must match whitelist
  linux?: string[];
  // when total size of stdout and stderr hits this amount, command is terminated, and
  // truncated is set.  The total amount of output may thus be slightly larger than maxOutput
  maxSize?: number;
  // command is terminated after this many ms
  timeout?: number;
  // Run in a separate POSIX process group and terminate descendants on timeout.
  // Privileged children still require root-owned/cgroup supervision by the helper.
  killProcessGroup?: boolean;
  // each command line option that is explicitly whitelisted
  // should be a key in the following whitelist map.
  // The value can be either:
  //   - true: in which case the option does not take a argument, or
  //   - a function: in which the option takes exactly one argument; the function should validate that argument
  //     and throw an error if the argument is not allowed.
  whitelist?: { [option: string]: true | ValidateFunction };
  // where to launch command
  cwd?: string;

  // options that are always included first for safety and need NOT match whitelist
  safety?: string[];

  // if nodejs is running as root and give this username, then cmd runs as this
  // user instead.
  username?: string;

  // by default the environment is EMPTY, which is usually what we want for fairly
  // locked down execution.  Use this to add something nontrivial to the default empty.
  env?: { [name: string]: string };

  // optional streaming handlers for line-oriented output
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

type ValidateFunction = (value: string) => void;

export default async function exec({
  cmd,
  positionalArgs = [],
  prefixArgs = [],
  options = [],
  linux = [],
  darwin = [],
  safety = [],
  maxSize = DEFAULT_MAX_SIZE,
  timeout = DEFAULT_TIMEOUT,
  killProcessGroup = false,
  whitelist = {},
  cwd,
  username,
  env = {},
  onStdoutLine,
  onStderrLine,
}: Options): Promise<ExecOutput> {
  options = selectPlatformOptions(options, { darwin, linux });
  options = safety.concat(parseAndValidateOptions(options, whitelist));
  const userId = username ? await getUserIds(username) : undefined;

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let truncated = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";

    let args = prefixArgs.concat(options);
    if (positionalArgs.length > 0) {
      args.push("--", ...positionalArgs);
    }

    logger.debug(formatCommandForLog({ cwd, cmd, args }));

    //console.log(`${cmd} ${args.join(" ")}`, { cwd, env });
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: killProcessGroup && platform() !== "win32",
      // env as any because otherwise pnpm build with nextjs says " Property 'NODE_ENV' is
      // missing in type '{ [name: string]: string; }' but required in type 'ProcessEnv'"
      env: env as any,
      cwd,
      ...userId,
    });

    let timeoutHandle: NodeJS.Timeout | null = null;
    let killHandle: NodeJS.Timeout | null = null;
    let closed = false;
    let terminating = false;

    const signal = (name: NodeJS.Signals) => {
      if (closed) return;
      if (killProcessGroup && platform() !== "win32" && child.pid != null) {
        try {
          process.kill(-child.pid, name);
        } catch (err) {
          if (err?.code !== "ESRCH") {
            logger.warn("failed to signal command process group", {
              pid: child.pid,
              signal: name,
              err: `${err}`,
            });
          }
        }
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill(name);
      }
    };

    const terminate = () => {
      truncated = true;
      if (terminating || closed) return;
      terminating = true;
      signal("SIGTERM");
      // child.killed means a signal was sent, NOT that the process exited.
      // A process-group leader may also exit while descendants keep pipes open.
      killHandle = setTimeout(() => signal("SIGKILL"), 1000);
    };

    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
    };

    if (timeout > 0) {
      timeoutHandle = setTimeout(terminate, timeout);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize + stderrSize >= maxSize) {
        terminate();
        return;
      }
      stdoutChunks.push(chunk);
      if (onStdoutLine) {
        stdoutLineBuffer = feedLines(
          stdoutLineBuffer,
          chunk.toString("utf8"),
          onStdoutLine,
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stdoutSize + stderrSize > maxSize) {
        terminate();
        return;
      }
      stderrChunks.push(chunk);
      if (onStderrLine) {
        stderrLineBuffer = feedLines(
          stderrLineBuffer,
          chunk.toString("utf8"),
          onStderrLine,
        );
      }
    });

    child.on("error", (err) => {
      // A spawn failure has no process to await. A signaling error must not
      // release a job's lock while the process may still be running.
      if (child.pid == null) {
        closed = true;
        clearTimers();
        reject(err);
      } else {
        logger.warn("command process error", { pid: child.pid, err: `${err}` });
        terminate();
      }
    });

    child.once("close", (code) => {
      closed = true;
      clearTimers();
      if (onStdoutLine && stdoutLineBuffer.trim()) {
        safeLineCallback(onStdoutLine, stdoutLineBuffer.trim());
      }
      if (onStderrLine && stderrLineBuffer.trim()) {
        safeLineCallback(onStderrLine, stderrLineBuffer.trim());
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: terminating ? code || 1 : code,
        truncated,
      });
    });
  });
}

function feedLines(
  buffer: string,
  chunk: string,
  onLine: (line: string) => void,
): string {
  const combined = (buffer + chunk).replace(/\r/g, "\n");
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    safeLineCallback(onLine, trimmed);
  }
  return remainder;
}

function safeLineCallback(onLine: (line: string) => void, line: string) {
  try {
    onLine(line);
  } catch (err) {
    logger.debug("exec onLine callback failed", { err: `${err}` });
  }
}

export function parseAndValidateOptions(
  options: string[],
  whitelist,
): string[] {
  const validatedOptions: string[] = [];
  let i = 0;

  while (i < options.length) {
    const opt = options[i];

    // Check if this is a safe option
    const validate = whitelist[opt];
    if (!validate) {
      throw new Error(`Disallowed option: ${opt}`);
    }
    validatedOptions.push(opt);

    // Handle options that take values
    if (validate !== true) {
      i++;
      if (i >= options.length) {
        throw new Error(`Option ${opt} requires a value`);
      }
      const value = String(options[i]);
      validate(value);
      // didn't throw, so good to go
      validatedOptions.push(value);
    }
    i++;
  }
  return validatedOptions;
}

export function selectPlatformOptions(
  options: string[],
  {
    darwin = [],
    linux = [],
    platformName = platform(),
  }: { darwin?: string[]; linux?: string[]; platformName?: string } = {},
): string[] {
  if (platformName === "darwin") {
    return options.concat(darwin);
  }
  if (platformName === "linux") {
    return options.concat(linux);
  }
  return options;
}

function formatCommandForLog({
  cwd,
  cmd,
  args,
}: {
  cwd?: string;
  cmd: string;
  args: string[];
}): string {
  const redactedArgs = redactArgs(args);
  return (cwd ? `cd ${cwd}; ` : "") + `${cmd} ${redactedArgs.join(" ")}`;
}

const SENSITIVE_OPTIONS = new Set([
  "-p",
  "--password",
  "--passphrase",
  "--token",
  "--secret",
]);

function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [opt, value] = arg.split("=", 2);
    if (SENSITIVE_OPTIONS.has(opt)) {
      if (value !== undefined) {
        redacted.push(`${opt}=REDACTED`);
      } else {
        redacted.push(opt);
        if (i + 1 < args.length) {
          redacted.push("REDACTED");
          i += 1;
        }
      }
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

export const validate = {
  str: () => {},
  set: (allowed) => {
    allowed = new Set(allowed);
    return (value: string) => {
      if (!allowed.has(value)) {
        throw Error("invalid value");
      }
    };
  },
  int: (value: string) => {
    if (!/^[+-]?\d+$/.test(value)) {
      throw Error("argument must be an integer");
    }
    const x = Number(value);
    if (!Number.isFinite(x)) {
      throw Error("argument must be a number");
    }
  },
  float: (value: string) => {
    if (value.trim() !== value || value.length === 0) {
      throw Error("argument must be a number");
    }
    const x = Number(value);
    if (!Number.isFinite(x)) {
      throw Error("argument must be a number");
    }
  },
  relativePath: (value: string) => {
    if (value.length === 0) {
      throw Error("path must not be empty");
    }
    if (value.includes("\0")) {
      throw Error("invalid path");
    }
    if (value.startsWith("/")) {
      throw Error("path must be relative");
    }
    const normalized = posix.normalize(value);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw Error("path must stay within working directory");
    }
  },
};

async function getUserIds(
  username: string,
): Promise<{ uid: number; gid: number }> {
  return Promise.all([
    new Promise<number>((resolve, reject) => {
      execFile("id", ["-u", username], (err, stdout) => {
        if (err) return reject(err);
        resolve(parseInt(stdout.trim(), 10));
      });
    }),
    new Promise<number>((resolve, reject) => {
      execFile("id", ["-g", username], (err, stdout) => {
        if (err) return reject(err);
        resolve(parseInt(stdout.trim(), 10));
      });
    }),
  ]).then(([uid, gid]) => ({ uid, gid }));
}

// take the output of exec and convert stdout, stderr to strings.  If code is nonzero,
// instead throw an error with message stderr.
export function parseOutput({ stdout, stderr, code, truncated }: ExecOutput) {
  if (code !== 0 || truncated) {
    throw new Error(
      Buffer.from(stderr).toString() ||
        (truncated
          ? "command exceeded its time or output limit"
          : `command failed with exit code ${code}`),
    );
  }
  return {
    stdout: Buffer.from(stdout).toString(),
    stderr: Buffer.from(stderr).toString(),
    truncated,
  };
}
