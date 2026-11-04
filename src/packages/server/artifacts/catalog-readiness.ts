/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Whether this bay serves catalog deltas and runs the change-hint drainer.
// Deltas are served only once the change log's reset-sentinel constraint is
// validated (existing rows checked), so a reader never applies a change log
// that could hold a malformed reset.

import getPool from "@cocalc/database/pool";
import { artifactCatalogChangeCheckValidated } from "@cocalc/database/postgres/schema/artifact-catalog-change-check";

const TTL_MS = 60_000;
let validated: { value: boolean; at: number } | undefined;
let hintsRunning = false;

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

export function setArtifactCatalogHintsRunning(running: boolean): void {
  hintsRunning = running;
}

export function artifactCatalogHintsRunning(): boolean {
  return hintsRunning;
}

export function resetArtifactCatalogReadinessForTests(): void {
  validated = undefined;
  hintsRunning = false;
}
