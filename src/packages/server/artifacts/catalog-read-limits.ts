/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Per-account bounds on artifact catalog reads, in this hub process: at most
// `concurrent` reads in flight and `perWindow` started per window. They cap
// abuse and runaway clients; they are not a fairness scheduler.

export type ArtifactCatalogReadKind = "getEntries";

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
};

export const ARTIFACT_CATALOG_READ_LIMITED =
  "artifact catalog read rate limit exceeded; retry later";

interface State {
  active: number;
  started: number[];
}

const states = new Map<string, State>();

export async function withArtifactCatalogReadLimit<T>(
  account_id: string,
  kind: ArtifactCatalogReadKind,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const rule = ARTIFACT_CATALOG_READ_LIMITS[kind];
  const key = `${kind}:${account_id}`;
  const state = states.get(key) ?? { active: 0, started: [] };
  const t = now();
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
    if (state.active === 0 && state.started.length === 0) states.delete(key);
  }
}

export function resetArtifactCatalogReadLimitsForTests(): void {
  states.clear();
}
