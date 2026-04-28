/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return `${err ?? ""}`;
}

export function isCollaboratorRealtimeAccessError(err: unknown): boolean {
  const text = errorText(err);
  return (
    text.includes("user must be a collaborator on project") ||
    text.includes("permission denied subscribing to 'project.") ||
    text.includes('permission denied subscribing to "project.')
  );
}
