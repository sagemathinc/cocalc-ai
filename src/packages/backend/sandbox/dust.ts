import exec, {
  parseAndValidateOptions,
  selectPlatformOptions,
  type ExecOutput,
  validate,
} from "./exec";
import { type DustOptions } from "@cocalc/conat/files/fs";
export { type DustOptions };
import { dust as dustPath } from "./install";
import { existsSync } from "node:fs";

const fallbackDustPaths = [
  "/opt/cocalc/bin2/dust",
  "/usr/local/bin/dust",
  "/usr/bin/dust",
];

export function resolveDustCommandPath(
  exists: (path: string) => boolean = existsSync,
): string {
  return findDustCommandPath(exists) ?? dustPath;
}

function findDustCommandPath(
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (exists(dustPath)) {
    return dustPath;
  }
  for (const path of fallbackDustPaths) {
    if (exists(path)) {
      return path;
    }
  }
  return undefined;
}

export default async function dust(
  path: string,
  { options, darwin, linux, timeout, maxSize }: DustOptions = {},
): Promise<ExecOutput> {
  if (path == null) {
    throw Error("path must be specified");
  }

  const cmd = findDustCommandPath();
  if (!cmd) {
    return await dustWithDuFallback(path, {
      options,
      darwin,
      linux,
      timeout,
      maxSize,
    });
  }

  try {
    return await exec({
      cmd,
      cwd: path,
      positionalArgs: [path],
      options,
      darwin,
      linux,
      maxSize,
      timeout,
      whitelist,
    });
  } catch (err) {
    if (!`${err}`.includes("ENOENT")) {
      throw err;
    }
    return await dustWithDuFallback(path, {
      options,
      darwin,
      linux,
      timeout,
      maxSize,
    });
  }
}

async function dustWithDuFallback(
  path: string,
  { options, darwin, linux, timeout, maxSize }: DustOptions = {},
): Promise<ExecOutput> {
  const selectedOptions = selectPlatformOptions(options ?? [], {
    darwin,
    linux,
  });
  const validatedOptions = parseAndValidateOptions(selectedOptions, whitelist);
  if (!hasFlag(validatedOptions, "-j", "--output-json")) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        "dust binary not found; du fallback only supports JSON output",
      ),
      code: 1,
      truncated: false,
    };
  }
  const depth = getIntegerOption(validatedOptions, "-d", "--depth") ?? 1;
  const duCmd = existsSync("/usr/bin/du") ? "/usr/bin/du" : "/bin/du";
  const duOutput = await exec({
    cmd: duCmd,
    cwd: path,
    prefixArgs: ["-B1", "-x", "-d", `${depth}`],
    positionalArgs: [path],
    maxSize,
    timeout,
  });
  if (duOutput.code || duOutput.truncated) {
    return duOutput;
  }
  return {
    ...duOutput,
    stdout: Buffer.from(duOutputToDustJson(duOutput.stdout, path)),
  };
}

function hasFlag(options: string[], short: string, long: string): boolean {
  return options.includes(short) || options.includes(long);
}

function getIntegerOption(
  options: string[],
  short: string,
  long: string,
): number | undefined {
  for (let i = 0; i < options.length - 1; i++) {
    if (options[i] === short || options[i] === long) {
      const value = Number(options[i + 1]);
      if (Number.isInteger(value) && value >= 0) {
        return value;
      }
    }
  }
}

export function duOutputToDustJson(stdout: Buffer, rootPath: string): string {
  const rows = Buffer.from(stdout)
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [size, ...nameParts] = line.split(/\s+/);
      return { size: Number(size), name: nameParts.join(" ") };
    })
    .filter(({ size, name }) => Number.isFinite(size) && !!name);
  const root = rows.find(({ name }) => name === rootPath) ?? rows.at(-1);
  const children = rows
    .filter(({ name }) => name !== root?.name)
    .map(({ size, name }) => ({ size: `${size}B`, name, children: [] }));
  return JSON.stringify({
    size: `${root?.size ?? 0}B`,
    name: root?.name ?? rootPath,
    children,
  });
}

const whitelist = {
  "-d": validate.int,
  "--depth": validate.int,

  "-n": validate.int,
  "--number-of-lines": validate.int,

  "-p": true,
  "--full-paths": true,

  "-X": validate.str,
  "--ignore-directory": validate.str,

  "-x": true,
  "--limit-filesystem": true,

  "-s": true,
  "--apparent-size": true,

  "-r": true,
  "--reverse": true,

  "-c": true,
  "--no-colors": true,
  "-C": true,
  "--force-colors": true,

  "-b": true,
  "--no-percent-bars": true,

  "-B": true,
  "--bars-on-right": true,

  "-z": validate.str,
  "--min-size": validate.str,

  "-R": true,
  "--screen-reader": true,

  "--skip-total": true,

  "-f": true,
  "--filecount": true,

  "-i": true,
  "--ignore-hidden": true,

  "-v": validate.str,
  "--invert-filter": validate.str,

  "-e": validate.str,
  "--filter": validate.str,

  "-t": validate.str,
  "--file-types": validate.str,

  "-w": validate.int,
  "--terminal-width": validate.int,

  "-P": true,
  "--no-progress": true,

  "--print-errors": true,

  "-D": true,
  "--only-dir": true,

  "-F": true,
  "--only-file": true,

  "-o": validate.str,
  "--output-format": validate.str,

  "-j": true,
  "--output-json": true,

  "-M": validate.str,
  "--mtime": validate.str,

  "-A": validate.str,
  "--atime": validate.str,

  "-y": validate.str,
  "--ctime": validate.str,

  "--collapse": validate.str,

  "-m": validate.set(["a", "c", "m"]),
  "--filetime": validate.set(["a", "c", "m"]),

  "-h": true,
  "--help": true,
  "-V": true,
  "--version": true,
} as const;
