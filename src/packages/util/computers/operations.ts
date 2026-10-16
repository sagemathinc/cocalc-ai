/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What `exec` carries from a project to a computer. The computer parses
// every request here, strictly, before it runs anything.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

export const MAX_COMMAND_BYTES = 32 * 1024;
export const MAX_ARGV_LENGTH = 4096;
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000;
/** exec returns at most this much output (stdout and stderr together). */
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;

export class OperationError extends Error {}

/**
 * What runs: a shell command line for the user's login shell, or (argv) the
 * exact arguments of one command, which no login shell parses. Exactly one
 * of the two is set.
 */
export interface CommandSpec {
  command: string | null;
  argv: string[] | null;
}

export interface ExecRequest extends CommandSpec {
  /** Relative to the computer's home directory, or absolute. */
  cwd: string | null;
  timeout_ms: number;
  /** base64 of stdin; null means stdin is closed. */
  stdin: string | null;
}

export interface ExecResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  /** The connector stopped it (it was revoked or shut down). */
  cancelled: boolean;
  stdout: string;
  stderr: string;
  /** More output than MAX_EXEC_OUTPUT_BYTES: the rest was dropped. */
  truncated: boolean;
  duration_ms: number;
}

/** Parse an exec request into its canonical form (defaults filled in). */
export function parseExecRequest(input: unknown): ExecRequest {
  const o = record(input ?? {}, "request");
  onlyKeys(o, ["command", "argv", "cwd", "timeout_ms", "stdin"], "exec");
  const timeout_ms =
    o.timeout_ms == null
      ? DEFAULT_EXEC_TIMEOUT_MS
      : positiveInt(o.timeout_ms, "timeout_ms", MAX_EXEC_TIMEOUT_MS);
  let stdin: string | null = null;
  if (o.stdin != null) {
    if (
      typeof o.stdin !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(o.stdin)
    ) {
      throw new OperationError("stdin must be base64");
    }
    if ((o.stdin.length * 3) / 4 > MAX_STDIN_BYTES) {
      throw new OperationError(`stdin is at most ${MAX_STDIN_BYTES} bytes`);
    }
    stdin = o.stdin;
  }
  return { ...commandSpec(o), cwd: cwd(o.cwd), timeout_ms, stdin };
}

function commandSpec(o: Record<string, unknown>): CommandSpec {
  if ((o.command == null) === (o.argv == null)) {
    throw new OperationError("give either command or argv");
  }
  if (o.command != null) {
    const value = o.command;
    if (typeof value !== "string" || value.trim() === "") {
      throw new OperationError("command must be a non-empty string");
    }
    commandSize(value);
    return { command: value, argv: null };
  }
  const argv = o.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > MAX_ARGV_LENGTH ||
    !argv.every((a) => typeof a === "string") ||
    argv[0] === ""
  ) {
    throw new OperationError(
      `argv must be a command and its arguments (at most ${MAX_ARGV_LENGTH} strings)`,
    );
  }
  // Bound what actually travels (one environment string on the computer).
  commandSize(argvScript(argv));
  return { command: null, argv: [...argv] };
}

function commandSize(value: string): void {
  if (new TextEncoder().encode(value).length > MAX_COMMAND_BYTES) {
    throw new OperationError(`command is at most ${MAX_COMMAND_BYTES} bytes`);
  }
  if (value.includes("\u0000"))
    throw new OperationError("command contains NUL");
}

/** POSIX sh quoting, exact for every string without NUL. */
export function posixQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The sh script that sets an argv as the positional parameters: every value
 * is in argument position after a fixed `set --`, so none can become an
 * assignment, a reserved word or an operator; the command is then "$@".
 */
export function argvScript(argv: string[]): string {
  return `set -- ${argv.map(posixQuote).join(" ")}`;
}

/** How a request's command reads, for audit and job lists. */
export function commandText(spec: CommandSpec): string {
  return spec.command ?? (spec.argv ?? []).map(posixQuote).join(" ");
}

function cwd(value: unknown): string | null {
  if (value == null || value === "") return null;
  return pathLike(value, "cwd");
}

function pathLike(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\u0000") ||
    value.trim() === ""
  ) {
    throw new OperationError(`${where} is not a valid path`);
  }
  return value;
}

function positiveInt(value: unknown, where: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new OperationError(`${where} must be an integer from 1 to ${max}`);
  }
  return value;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new OperationError(`${where}: unknown field '${key}'`);
    }
  }
}
