/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Per-account bounds on artifact catalog reads, in this hub process: at most
// `concurrent` reads in flight and `perWindow` started per window. They cap
// abuse and runaway clients; they are not a fairness scheduler. With several
// hub processes the effective bound is these values times the hub count.

export type ArtifactCatalogReadKind =
  | "getEntries"
  | "listAccount"
  | "listAccountProbe"
  | "search";

interface Rule {
  concurrent: number;
  perWindow: number;
  windowMs: number;
}

export const ARTIFACT_CATALOG_READ_LIMITS: Record<
  ArtifactCatalogReadKind,
  Rule
> = {
  getEntries: { concurrent: 4, perWindow: 10, windowMs: 10_000 },
  listAccount: { concurrent: 2, perWindow: 20, windowMs: 10_000 },
  // limit: 0 version probes (repair and the visible-only safety probe).
  listAccountProbe: { concurrent: 2, perWindow: 6, windowMs: 60_000 },
  // Any request with a query, in addition to its page or probe limit.
  search: { concurrent: 2, perWindow: 10, windowMs: 10_000 },
};

export const ARTIFACT_CATALOG_READ_LIMITED =
  "artifact catalog read rate limit exceeded; retry later";

interface State {
  active: number;
  started: number[];
}

const states = new Map<string, State>();
let callsSinceSweep = 0;
const SWEEP_EVERY_CALLS = 1000;

// Drop accounts with nothing in flight and no starts left in their window,
// so the map holds only recently active callers.
function sweep(t: number): void {
  for (const [key, state] of states) {
    const rule = ARTIFACT_CATALOG_READ_LIMITS[key.split(":")[0]];
    const windowMs = rule?.windowMs ?? 0;
    state.started = state.started.filter((at) => t - at < windowMs);
    if (state.active === 0 && state.started.length === 0) states.delete(key);
  }
}

export async function withArtifactCatalogReadLimit<T>(
  account_id: string,
  kind: ArtifactCatalogReadKind,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const rule = ARTIFACT_CATALOG_READ_LIMITS[kind];
  const key = `${kind}:${account_id}`;
  const t = now();
  if (++callsSinceSweep >= SWEEP_EVERY_CALLS) {
    callsSinceSweep = 0;
    sweep(t);
  }
  const state = states.get(key) ?? { active: 0, started: [] };
  state.started = state.started.filter((at) => t - at < rule.windowMs);
  if (state.active >= rule.concurrent || state.started.length >= rule.perWindow)
    throw Error(ARTIFACT_CATALOG_READ_LIMITED);
  state.active++;
  state.started.push(t);
  states.set(key, state);
  try {
    return await fn();
  } finally {
    state.active--;
  }
}

/** Number of tracked callers (tests and diagnostics). */
export function artifactCatalogReadLimitEntries(): number {
  return states.size;
}

export function resetArtifactCatalogReadLimitsForTests(): void {
  states.clear();
  callsSinceSweep = 0;
}
