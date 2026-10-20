/*
Per-key backoff for fetching persisted activity logs.

Every chat row with an activity log fetches it when it mounts.  While the
project host is unreachable each fetch fails at once, and rows remount often
(scrolling, re-renders), so without this a tab retried several times a second
and logged a stack trace each time.  Failures are remembered per log key: a
fetch waits out the key's backoff, and only the first failure and every tenth
after it are logged.
*/

import { getLogger } from "@cocalc/conat/logger";

const logger = getLogger("frontend:chat:log-fetch-backoff");

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const LOG_EVERY = 10;
const MAX_KEYS = 1_000;

interface Failure {
  count: number;
  nextAttemptAt: number;
}

const failures = new Map<string, Failure>();

// ms to wait before fetching key; 0 means fetch now.
export function logFetchDelay(key: string, now = Date.now()): number {
  const failure = failures.get(key);
  return failure == null ? 0 : Math.max(0, failure.nextAttemptAt - now);
}

export function noteLogFetchSuccess(key: string): void {
  failures.delete(key);
}

export function noteLogFetchFailure(
  key: string,
  err: unknown,
  now = Date.now(),
): void {
  const count = (failures.get(key)?.count ?? 0) + 1;
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (count - 1));
  failures.delete(key);
  failures.set(key, { count, nextAttemptAt: now + delay });
  if (failures.size > MAX_KEYS) {
    const oldest = failures.keys().next().value;
    if (oldest != null) failures.delete(oldest);
  }
  if (count == 1 || count % LOG_EVERY == 0) {
    // A string, not the Error: the console prints a full stack for an Error.
    logger.warn(
      `failed to fetch acp log (${count} ${count == 1 ? "failure" : "failures"}, next try in ${Math.round(delay / 1000)}s): ${(err as any)?.message ?? err}`,
    );
  }
}

export function resetLogFetchBackoffForTests(): void {
  failures.clear();
}
