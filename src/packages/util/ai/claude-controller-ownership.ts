/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface ClaudeControllerOwner {
  holder: string;
  host_id: string;
  project_id: string;
  // Host boot + worker PID/start-time fingerprint, not an authorization token.
  runtime_id?: string;
}

export interface ClaudeControllerOwnershipRequest extends ClaudeControllerOwner {
  // Omitted only for a first sign-in, before a credential row exists.
  credential_id?: string;
  owner_account_id: string;
  operation: "acquire" | "release";
  purpose?: "controller" | "sign-in";
}

export type ClaudeControllerOwnershipResult = "acquired" | "busy" | "released";

export const CLAUDE_CONTROLLER_BUSY = "CLAUDE_CONTROLLER_BUSY";
export const CLAUDE_CONTROLLER_FENCED = "CLAUDE_CONTROLLER_FENCED";
