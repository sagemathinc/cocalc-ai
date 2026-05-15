/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function sanitizeAllowCollaboratorStartsUsingSponsor(
  value: unknown,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object") {
    const candidate = (value as any).allow_collaborator_starts_using_sponsor;
    if (candidate !== undefined) {
      return sanitizeAllowCollaboratorStartsUsingSponsor(candidate);
    }
    const getter = (value as any).get;
    if (typeof getter === "function") {
      const maybe = getter.call(
        value,
        "allow_collaborator_starts_using_sponsor",
      );
      if (maybe !== undefined) {
        return sanitizeAllowCollaboratorStartsUsingSponsor(maybe);
      }
    }
  }
  if (typeof value !== "boolean") {
    throw Error("allow_collaborator_starts_using_sponsor must be a boolean");
  }
  return value;
}
