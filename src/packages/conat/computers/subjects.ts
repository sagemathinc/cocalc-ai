/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Conat subjects of computers, on the host of the project they serve.
// Design: src/.agents/computers-direct-host-2026-10-16.md.
//
//   computer.<project_id>.<computer_id>.exec   project -> that computer
//   computer.<project_id>.hello                project -> every computer of it
//
// A computer answers on the requester's reply inbox. Nothing else under
// "computer." exists, and only these rules grant anything there.

import { isValidUUID } from "@cocalc/util/misc";
import type { ExecResult } from "@cocalc/util/computers/operations";
import type { ComputerPrincipal } from "./principal";

export function computerExecSubject(
  project_id: string,
  computer_id: string,
): string {
  return `computer.${uuid(project_id)}.${uuid(computer_id)}.exec`;
}

export function computerHelloSubject(project_id: string): string {
  return `computer.${uuid(project_id)}.hello`;
}

export type ComputerSubject =
  | { kind: "exec"; project_id: string; computer_id: string }
  | { kind: "hello"; project_id: string };

/** The computer subject named exactly, or null (anything else, wildcards). */
export function parseComputerSubject(subject: string): ComputerSubject | null {
  const parts = subject.split(".");
  if (parts[0] !== "computer" || !isValidUUID(parts[1])) return null;
  if (parts.length === 3 && parts[2] === "hello") {
    return { kind: "hello", project_id: parts[1] };
  }
  if (parts.length === 4 && parts[3] === "exec" && isValidUUID(parts[2])) {
    return { kind: "exec", project_id: parts[1], computer_id: parts[2] };
  }
  return null;
}

export function isComputerSubject(subject: string): boolean {
  return subject === "computer" || subject.startsWith("computer.");
}

/**
 * What a computer may do: receive on its own two subjects and answer on
 * reply inboxes. Its project and token are checked separately.
 */
export function computerPrincipalAllows(
  computer: Pick<ComputerPrincipal, "computer_id" | "computer_project_id">,
  subject: string,
  type: "sub" | "pub",
): boolean {
  if (type === "pub") return subject.startsWith("_INBOX.");
  const parsed = parseComputerSubject(subject);
  if (parsed == null || parsed.project_id !== computer.computer_project_id) {
    return false;
  }
  return parsed.kind === "hello" || parsed.computer_id === computer.computer_id;
}

/**
 * Who may ask computers of project P: P itself (its processes, including an
 * agent's token bound to P). Nobody subscribes here except the computers.
 */
export function computerSubjectRequesterAllows(
  project_id: string | undefined,
  subject: string,
  type: "sub" | "pub",
): boolean {
  if (type !== "pub" || !project_id) return false;
  const parsed = parseComputerSubject(subject);
  return parsed != null && parsed.project_id === project_id;
}

export interface ComputerExecMessage {
  v: 1;
  /** An ExecRequest; the computer parses it strictly. */
  request: unknown;
}

export type ComputerExecReply =
  | { v: 1; ok: true; result: ExecResult }
  | { v: 1; ok: false; error: string };

export interface ComputerHello {
  v: 1;
  computer_id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  user: string;
  /** Commands running there now. */
  running: number;
}

function uuid(value: string): string {
  if (!isValidUUID(value)) throw new Error("invalid uuid");
  return value;
}
