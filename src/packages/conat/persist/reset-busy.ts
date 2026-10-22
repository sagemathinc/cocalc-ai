/*
The persist server holds at most one resetHistory request per stream at a
time (the reset slot, server.ts); another one is answered at once, as busy,
instead of waiting.  Callers that used to simply wait for the other reset
retry instead, for about as long as the server's own wait used to be, so
what they see does not change: the other reset's outcome, through their own
conditions (epoch, revision, opId).

Shared by every resetHistory caller (sync-client.ts, hub/api/sync-impl.ts).
*/

import type { ResetHistoryResult } from "./storage";

// About the 30 s a request used to wait for its stream on the server.
export const RESET_BUSY_ATTEMPTS = 30;
export const RESET_BUSY_DELAY_MS = 1000;

// The server's answer when it cannot admit a reset now: a refusal (another
// reset of the stream is in progress), or an error with code 409 whose
// message starts with "resetHistory: busy" (the same while this socket's
// stream is not open yet, or this socket has not said which stream it is).
export const RESET_BUSY_ERROR = "resetHistory: busy";

export function isResetBusy(x: unknown): boolean {
  if (x == null) return false;
  if ((x as ResetHistoryResult).refused === "busy") return true;
  return (
    (x as any)?.code == 409 &&
    `${(x as any)?.message ?? x}`.includes(RESET_BUSY_ERROR)
  );
}

// Runs reset() until the server is no longer busy with another reset of the
// same stream, at most attempts times; the last answer otherwise.
export async function retryWhileResetBusy<T>(
  reset: () => Promise<T>,
  {
    attempts = RESET_BUSY_ATTEMPTS,
    delayMs = RESET_BUSY_DELAY_MS,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await reset();
      if (!isResetBusy(result) || attempt >= attempts) return result;
    } catch (err) {
      if (!isResetBusy(err) || attempt >= attempts) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
