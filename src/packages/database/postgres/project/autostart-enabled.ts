/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function sanitizeAutostartEnabled(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object") {
    const candidate = (value as any).autostart_enabled;
    if (candidate !== undefined) {
      return sanitizeAutostartEnabled(candidate);
    }
    const getter = (value as any).get;
    if (typeof getter === "function") {
      const maybe = getter.call(value, "autostart_enabled");
      if (maybe !== undefined) {
        return sanitizeAutostartEnabled(maybe);
      }
    }
  }
  if (typeof value !== "boolean") {
    throw Error("autostart_enabled must be a boolean");
  }
  return value;
}
