/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The account's computers, for @name suggestions in chat: one shared list,
// loaded when something needs it and at most every 30 s.

import { useEffect, useState } from "react";
import type { ComputerSummary } from "@cocalc/util/computers/api";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const FRESH_MS = 30_000;

let computers: ComputerSummary[] = [];
let loadedAt = 0;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function load(): void {
  if (loading || Date.now() - loadedAt < FRESH_MS) return;
  loading = (async () => {
    try {
      computers = await webapp_client.conat_client.hub.computers.listComputers(
        {},
      );
      for (const listener of listeners) listener();
    } catch {
      // Suggestions are a convenience: without the list, none are offered.
    } finally {
      loadedAt = Date.now();
      loading = undefined;
    }
  })();
}

/** Not disconnected and not past its time. */
export function isLive(c: ComputerSummary, now = Date.now()): boolean {
  return c.revoked_at == null && (c.deadline == null || c.deadline > now);
}

export function useComputers(enabled: boolean): ComputerSummary[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    load();
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);
  return enabled ? computers : [];
}
