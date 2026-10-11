/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Writers that decide from a host row they read earlier apply only the
// top-level metadata keys they changed relative to that row (and the keys they
// removed), so they cannot put back what others changed meanwhile.
export function metadataPatch(
  previous: Record<string, any> | null | undefined,
  next: Record<string, any> | null | undefined,
): { set: Record<string, any>; remove: string[] } {
  const before = previous ?? {};
  const after = next ?? {};
  const set: Record<string, any> = {};
  const remove: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (after[key] === undefined) {
      if (before[key] !== undefined) remove.push(key);
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      set[key] = after[key];
    }
  }
  return { set, remove };
}

// SET fragment applying a patch: $removeParam is a text[] of removed keys,
// $setParam a jsonb object of changed keys.
export function metadataPatchAssignment(
  setParam: number,
  removeParam: number,
): string {
  return `metadata = (COALESCE(metadata, '{}'::jsonb) - $${removeParam}::text[]) || $${setParam}::jsonb`;
}
