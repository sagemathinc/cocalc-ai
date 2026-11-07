/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether this bay serves catalog deltas and change hints. Deltas are served
// only once the change log's reset-sentinel constraint is validated (existing
// rows checked), so a reader never applies a change log that could hold a
// malformed reset. Hints are a bay-wide setting, read the same way by every
// bay worker (each of which runs a drainer), so every worker answers alike.
// Also the in-process nudge that lets a worker's own drainer deliver a hint
// as soon as a change it made has committed.

import getPool from "@cocalc/database/pool";
import { artifactCatalogChangeCheckValidated } from "@cocalc/database/postgres/schema/artifact-catalog-change-check";

const TTL_MS = 60_000;
let validated: { value: boolean; at: number } | undefined;
let nudge: (() => void) | undefined;

export async function artifactCatalogDeltasReady(
  now = Date.now(),
): Promise<boolean> {
  if (!validated || now - validated.at >= TTL_MS) {
    validated = {
      value: await artifactCatalogChangeCheckValidated(getPool()),
      at: now,
    };
  }
  return validated.value;
}

/** Hints are on unless COCALC_ARTIFACT_CATALOG_HINTS=off on this bay. */
export function artifactCatalogHintsEnabled(): boolean {
  return `${process.env.COCALC_ARTIFACT_CATALOG_HINTS ?? ""}`.trim() !== "off";
}

/** The drainer of this worker registers how to wake it. */
export function registerArtifactCatalogHintNudge(
  wake: (() => void) | undefined,
): void {
  nudge = wake;
}

/**
 * Wakes this worker's drainer. Call only after the change's transaction has
 * committed. A worker without a drainer does nothing; every drainer's
 * periodic scan finds the change anyway.
 */
export function nudgeArtifactCatalogHints(): void {
  nudge?.();
}

/** For promise chains: nudges once the transaction promise resolved. */
export function afterCatalogCommit<T>(value: T): T {
  nudgeArtifactCatalogHints();
  return value;
}

export function resetArtifactCatalogReadinessForTests(): void {
  validated = undefined;
  nudge = undefined;
}
