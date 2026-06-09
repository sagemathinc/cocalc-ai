/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { UxLatencyEventInput } from "@cocalc/conat/hub/api/system";

export function startUxTimer(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function elapsedUxMs(start: number): number {
  const now = globalThis.performance?.now?.() ?? Date.now();
  return Math.max(0, Math.round(now - start));
}

export function recordUxLatencyEvent(event: UxLatencyEventInput): void {
  void webapp_client.conat_client.hub.system
    .recordUxLatencyEvent({ event })
    .catch(() => {
      // Telemetry must never affect the user-visible action being measured.
    });
}
