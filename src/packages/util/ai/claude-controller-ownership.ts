/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface ClaudeControllerOwner {
  holder: string;
  host_id: string;
  project_id: string;
}

export interface ClaudeControllerOwnershipRequest extends ClaudeControllerOwner {
  credential_id: string;
  owner_account_id: string;
  operation: "acquire" | "release";
}

export type ClaudeControllerOwnershipResult = "acquired" | "busy" | "released";

export const CLAUDE_CONTROLLER_BUSY = "CLAUDE_CONTROLLER_BUSY";
export const CLAUDE_CONTROLLER_FENCED = "CLAUDE_CONTROLLER_FENCED";
