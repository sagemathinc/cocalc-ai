/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The account's computers, for @name suggestions in chat: one shared list,
// refreshed every 30 s while any composer that offers them is open.

import { useEffect, useState } from "react";
import type { ComputerSummary } from "@cocalc/util/computers/api";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const REFRESH_MS = 30_000;

let computers: ComputerSummary[] = [];
let loading: Promise<ComputerSummary[]> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

async function fetchComputers(): Promise<ComputerSummary[]> {
  try {
    computers = await webapp_client.conat_client.hub.computers.listComputers(
      {},
    );
    for (const listener of listeners) listener();
  } catch {
    // Suggestions are a convenience: the next refresh tries again.
  }
  return computers;
}

/** One load at a time; callers during a load share it. */
function load(): Promise<ComputerSummary[]> {
  if (loading) return loading;
  const p: Promise<ComputerSummary[]> = fetchComputers().finally(() => {
    if (loading === p) loading = undefined;
  });
  loading = p;
  return p;
}

/** Load the list now (e.g. before checking a message, or after a fix). */
export async function refreshComputers(): Promise<ComputerSummary[]> {
  if (loading) await loading;
  return await load();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer == null) {
    void load();
    timer = setInterval(() => void load(), REFRESH_MS);
  } else {
    listener();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Not disconnected and not past its time. */
export function isLive(c: ComputerSummary, now = Date.now()): boolean {
  return c.revoked_at == null && (c.deadline == null || c.deadline > now);
}

export function useComputers(enabled: boolean): ComputerSummary[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return subscribe(() => setVersion((v) => v + 1));
  }, [enabled]);
  return enabled ? computers : [];
}
