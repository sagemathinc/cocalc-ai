/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Waiting for an external member's inbox: `agent inbox --wait` checks the
remote inbox until a pending message is there (or it gives up), so that
`sensor watch inbox` (an exit watcher around it) wakes the agent when a
message arrives. Nothing is acknowledged here: the agent reads the messages
with `agent inbox` and acknowledges them itself.
*/

export interface ExternalInboxMessage {
  message_id: string;
  created_at: string;
  body: string;
  source?: unknown;
  attachments?: { name: string }[];
}

export const INBOX_WAIT_DEFAULT_POLL_SECONDS = 30;
export const INBOX_WAIT_MIN_POLL_SECONDS = 10;
export const INBOX_WAIT_MAX_HOURS = 24 * 7;
// consecutive failed checks before giving up (a revoked or missing profile
// shouldn't keep a watcher waiting for nothing)
export const INBOX_WAIT_MAX_FAILURES = 20;
const PREVIEW_CHARS = 200;

/** Check the inbox until it has a message, or until the deadline. */
export async function waitForExternalInbox({
  fetch,
  pollSeconds = INBOX_WAIT_DEFAULT_POLL_SECONDS,
  hours,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  onError,
}: {
  fetch: () => Promise<ExternalInboxMessage[]>;
  pollSeconds?: number;
  hours: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // a failed check (the remote site briefly unreachable) is retried
  onError?: (err: unknown) => void;
}): Promise<{ messages: ExternalInboxMessage[]; timed_out: boolean }> {
  if (!(hours > 0 && hours <= INBOX_WAIT_MAX_HOURS))
    throw new Error(
      `--wait-hours must be more than 0 and at most ${INBOX_WAIT_MAX_HOURS}`,
    );
  if (!Number.isFinite(pollSeconds))
    throw new Error("--poll must be a number of seconds");
  const pollMs =
    Math.max(INBOX_WAIT_MIN_POLL_SECONDS, Math.floor(pollSeconds)) * 1000;
  let failures = 0;
  const deadline = now() + hours * 3600_000;
  for (;;) {
    try {
      const messages = await fetch();
      failures = 0;
      if (messages.length > 0) return { messages, timed_out: false };
    } catch (err) {
      onError?.(err);
      if (++failures >= INBOX_WAIT_MAX_FAILURES) throw err;
    }
    const left = deadline - now();
    if (left <= 0) return { messages: [], timed_out: true };
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * What the wait prints: short previews (an exit watcher's wake shows the end
 * of the output), never whole messages or attachments.
 */
export function inboxWakeSummary(
  messages: ExternalInboxMessage[],
  profile: string,
  timed_out: boolean,
) {
  return {
    pending: messages.length,
    timed_out,
    messages: messages.map((m) => ({
      message_id: m.message_id,
      created_at: m.created_at,
      preview:
        m.body.length > PREVIEW_CHARS
          ? `${m.body.slice(0, PREVIEW_CHARS)}…`
          : m.body,
      ...(m.attachments?.length ? { attachments: m.attachments.length } : {}),
    })),
    next: timed_out
      ? `no message arrived; to keep waiting: cocalc sensor watch inbox --external-agent ${profile}`
      : `read them with: cocalc agent inbox --external-agent ${profile} (then agent ack-inbox ID)`,
  };
}
