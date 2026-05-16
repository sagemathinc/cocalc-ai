/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function sanitizeAllowCollaboratorDestructiveStorageActions(
  value: unknown,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object") {
    const candidate = (value as any)
      .allow_collaborator_destructive_storage_actions;
    if (candidate !== undefined) {
      return sanitizeAllowCollaboratorDestructiveStorageActions(candidate);
    }
    const getter = (value as any).get;
    if (typeof getter === "function") {
      const maybe = getter.call(
        value,
        "allow_collaborator_destructive_storage_actions",
      );
      if (maybe !== undefined) {
        return sanitizeAllowCollaboratorDestructiveStorageActions(maybe);
      }
    }
  }
  if (typeof value !== "boolean") {
    throw Error(
      "allow_collaborator_destructive_storage_actions must be a boolean",
    );
  }
  return value;
}
