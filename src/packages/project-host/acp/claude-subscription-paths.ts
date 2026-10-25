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

// Host-owned staging directories for a controller's transcripts (see
// claude-transcript-staging), labeled on the container for the reaper. The
// name carries the project, so staging can be bounded per project.
export const CLAUDE_TRANSCRIPT_STAGING_LABEL = "cocalc.acp.transcript-staging";
const STAGING_PREFIX = "cocalc-claude-transcripts-";
const STAGING_NAME = new RegExp(
  `^${STAGING_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[A-Za-z0-9]{6}$`,
);

export function claudeTranscriptStagingPrefix(projectId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      projectId,
    )
  )
    throw Error("Invalid project for Claude transcript staging");
  return join(tmpdir(), `${STAGING_PREFIX}${projectId}-`);
}

/** The project of a managed staging directory's name, or undefined. */
export function claudeTranscriptStagingProject(
  name: string,
): string | undefined {
  return STAGING_NAME.exec(name)?.[1];
}

export function isManagedClaudeTranscriptStaging(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    dirname(resolve(value)) === resolve(tmpdir()) &&
    claudeTranscriptStagingProject(basename(value)) !== undefined
  );
}
