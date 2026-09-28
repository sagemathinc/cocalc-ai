/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CLAUDE_CONTROLLER_HOME_LABEL = "cocalc.acp.credential-home";
const PREFIX = "cocalc-claude-controller-";

export function claudeControllerHomePrefix(): string {
  return join(tmpdir(), PREFIX);
}

export function isManagedClaudeControllerHome(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    dirname(resolve(value)) !== resolve(tmpdir())
  )
    return false;
  return new RegExp(`^${PREFIX}[A-Za-z0-9]{6}$`).test(basename(value));
}
