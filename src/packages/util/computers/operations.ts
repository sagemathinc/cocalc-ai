/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The request each operation carries. The hub hashes the canonical request
// into the ticket (request_hash), and the daemon only runs a request whose
// hash matches, so both sides parse requests here, strictly.
// Plan: src/.agents/computers-plan-2026-10-11.md ("How it looks to the agent").

import { isValidUUID } from "@cocalc/util/misc";
import type { OperationKind } from "./protocol";

export const MAX_COMMAND_BYTES = 32 * 1024;
export const MAX_ARGV_LENGTH = 4096;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_JOB_NAME_LENGTH = 64;
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000;
/** exec returns at most this much output; the rest stays on the machine. */
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_LOG_TAIL_LINES = 10_000;
/** One transfer moves at most this many bytes. */
export const MAX_TRANSFER_BYTES = 2 * 1024 ** 3;

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
  /** Relative to the computer's working directory, or absolute. */
  cwd: string | null;
  timeout_ms: number;
  /** base64 of stdin; null means stdin is closed. */
  stdin: string | null;
}

export interface RunRequest extends CommandSpec {
  cwd: string | null;
  /** Required short description, visible to the owner's other agents. */
  description: string;
  name: string | null;
  exclusive: boolean;
  /** Run under nice/ionice (default on computers without a time limit). */
  nice: boolean;
}

export interface JobRef {
  job_id: string;
}

export interface LogsRequest extends JobRef {
  tail_lines: number;
}

export interface OpsRequest {
  operation_id: string | null;
}

export interface TransferRequest {
  /** Path on the computer, relative to its working directory or absolute. */
  path: string;
  /** Total bytes (measured before a put; the cap for a get). */
  bytes: number;
  directory: boolean;
}

export type OperationRequest =
  | { operation: "info"; request: Record<string, never> }
  | { operation: "exec"; request: ExecRequest }
  | { operation: "run"; request: RunRequest }
  | { operation: "jobs"; request: Record<string, never> }
  | { operation: "logs"; request: LogsRequest }
  | { operation: "kill"; request: JobRef }
  | { operation: "ops"; request: OpsRequest }
  | { operation: "put"; request: TransferRequest }
  | { operation: "get"; request: TransferRequest };

/**
 * Parse one operation's request into its canonical form (defaults filled in,
 * no unknown fields). "notes" is handled at the hub and has no request here.
 */
export function parseOperationRequest(
  operation: OperationKind,
  input: unknown,
): OperationRequest {
  const o = record(input ?? {}, "request");
  switch (operation) {
    case "info":
    case "jobs":
      onlyKeys(o, [], operation);
      return { operation, request: {} };
    case "exec": {
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
      return {
        operation,
        request: {
          ...commandSpec(o),
          cwd: cwd(o.cwd),
          timeout_ms,
          stdin,
        },
      };
    }
    case "run": {
      onlyKeys(
        o,
        ["command", "argv", "cwd", "description", "name", "exclusive", "nice"],
        "run",
      );
      if (typeof o.description !== "string" || !o.description.trim()) {
        throw new OperationError(
          "a job needs a short description (other agents and the owner see it)",
        );
      }
      if (
        o.description.length > MAX_DESCRIPTION_LENGTH ||
        hasControl(o.description)
      ) {
        throw new OperationError(
          `a job description is at most ${MAX_DESCRIPTION_LENGTH} printable characters`,
        );
      }
      let name: string | null = null;
      if (o.name != null) {
        if (
          typeof o.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.name) ||
          o.name.length > MAX_JOB_NAME_LENGTH
        ) {
          throw new OperationError(
            "a job name is letters, digits, '.', '_' and '-'",
          );
        }
        name = o.name;
      }
      return {
        operation,
        request: {
          ...commandSpec(o),
          cwd: cwd(o.cwd),
          description: o.description.trim(),
          name,
          exclusive: bool(o.exclusive, false, "exclusive"),
          nice: bool(o.nice, true, "nice"),
        },
      };
    }
    case "logs":
      onlyKeys(o, ["job_id", "tail_lines"], "logs");
      return {
        operation,
        request: {
          job_id: uuid(o.job_id, "job_id"),
          tail_lines:
            o.tail_lines == null
              ? 200
              : positiveInt(o.tail_lines, "tail_lines", MAX_LOG_TAIL_LINES),
        },
      };
    case "kill":
      onlyKeys(o, ["job_id"], "kill");
      return { operation, request: { job_id: uuid(o.job_id, "job_id") } };
    case "ops":
      onlyKeys(o, ["operation_id"], "ops");
      return {
        operation,
        request: {
          operation_id:
            o.operation_id == null
              ? null
              : uuid(o.operation_id, "operation_id"),
        },
      };
    case "put":
    case "get":
      onlyKeys(o, ["path", "bytes", "directory"], operation);
      return {
        operation,
        request: {
          path: transferPath(o.path),
          bytes: positiveInt(o.bytes, "bytes", MAX_TRANSFER_BYTES),
          directory: bool(o.directory, false, "directory"),
        },
      };
    default:
      throw new OperationError(
        `operation '${operation}' has no machine request`,
      );
  }
}

/** How long an operation's ticket may let it run. */
export function maxRuntimeMs(op: OperationRequest): number {
  switch (op.operation) {
    case "exec":
      return op.request.timeout_ms;
    case "run":
      return 30 * 24 * 60 * 60 * 1000;
    case "put":
    case "get":
      return 6 * 60 * 60 * 1000;
    default:
      return 60 * 1000;
  }
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

function transferPath(value: unknown): string {
  return pathLike(value, "path");
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

function bool(value: unknown, fallback: boolean, where: string): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean")
    throw new OperationError(`${where} must be a boolean`);
  return value;
}

function uuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new OperationError(`${where} must be a UUID`);
  }
  return value.toLowerCase();
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
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
