/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const MAX_ENTRY_AGE_MS = 24 * 60 * 60_000;

type BrowserAuthSessionRecord = {
  session_hash: string;
  updated_at_ms: number;
};

const registry = new Map<string, BrowserAuthSessionRecord>();

function key(account_id: string, browser_id: string): string {
  return `${account_id}:${browser_id}`;
}

function prune(now = Date.now()): void {
  for (const [k, record] of registry) {
    if (now - record.updated_at_ms > MAX_ENTRY_AGE_MS) {
      registry.delete(k);
    }
  }
}

export function recordBrowserAuthSession({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id: string;
  browser_id?: string;
  session_hash?: string;
}): void {
  const cleanedBrowserId = `${browser_id ?? ""}`.trim();
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  if (!account_id || !cleanedBrowserId || !cleanedSessionHash) {
    return;
  }
  const now = Date.now();
  prune(now);
  registry.set(key(account_id, cleanedBrowserId), {
    session_hash: cleanedSessionHash,
    updated_at_ms: now,
  });
}

export function getBrowserAuthSessionHash({
  account_id,
  browser_id,
}: {
  account_id: string;
  browser_id?: string;
}): string | undefined {
  const cleanedBrowserId = `${browser_id ?? ""}`.trim();
  if (!account_id || !cleanedBrowserId) {
    return;
  }
  prune();
  return registry.get(key(account_id, cleanedBrowserId))?.session_hash;
}
