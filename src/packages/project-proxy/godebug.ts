/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// GODEBUG with setting (key=value) applied: other settings are kept, an
// existing value for the same key is replaced.
export function withGodebug(
  current: string | undefined,
  setting: string,
): string {
  const key = setting.split("=", 1)[0];
  const kept = `${current ?? ""}`
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s.split("=", 1)[0] !== key);
  return [...kept, setting].join(",");
}
