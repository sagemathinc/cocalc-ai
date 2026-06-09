/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const projectStartTimings = new Map<string, Record<string, number>>();

function normalizeOpId(op_id?: string): string {
  return `${op_id ?? ""}`.trim();
}

export function mergeStartProjectTimings(
  op_id: string | undefined,
  timings: Record<string, number | undefined>,
): void {
  const key = normalizeOpId(op_id);
  if (!key) {
    return;
  }
  const current = projectStartTimings.get(key) ?? {};
  for (const [name, value] of Object.entries(timings)) {
    if (value == null || !Number.isFinite(value)) {
      continue;
    }
    current[name] = Math.max(0, Math.round(value));
  }
  projectStartTimings.set(key, current);
}

export function takeStartProjectTimings(
  op_id?: string,
): Record<string, number> | undefined {
  const key = normalizeOpId(op_id);
  if (!key) {
    return;
  }
  const timings = projectStartTimings.get(key);
  projectStartTimings.delete(key);
  return timings;
}
