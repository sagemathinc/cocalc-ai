import assert from "node:assert/strict";
import test from "node:test";
import {
  INBOX_WAIT_MAX_FAILURES,
  inboxWakeSummary,
  waitForExternalInbox,
  type ExternalInboxMessage,
} from "./external-inbox-wait";

const message = (id: string, body = "hello"): ExternalInboxMessage => ({
  message_id: id,
  created_at: "2026-11-28T00:00:00.000Z",
  body,
  source: { agent_id: "a" },
});

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

test("waits until a message is there, at the poll interval", async () => {
  const c = clock();
  const results: ExternalInboxMessage[][] = [[], [], [message("m1")]];
  let calls = 0;
  const r = await waitForExternalInbox({
    fetch: async () => {
      calls++;
      return results.shift() ?? [];
    },
    hours: 1,
    pollSeconds: 30,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(r, { messages: [message("m1")], timed_out: false });
  assert.equal(calls, 3);
  assert.deepEqual(c.sleeps, [30_000, 30_000]);
});

test("gives up at the deadline, never sleeping past it", async () => {
  const c = clock();
  const r = await waitForExternalInbox({
    fetch: async () => [],
    hours: 1 / 60, // one minute
    pollSeconds: 25,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(r, { messages: [], timed_out: true });
  assert.deepEqual(c.sleeps, [25_000, 25_000, 10_000]);
});

test("polls at most every 10 seconds, and refuses bad arguments", async () => {
  const c = clock();
  const results: ExternalInboxMessage[][] = [[], [message("m")]];
  await waitForExternalInbox({
    fetch: async () => results.shift()!,
    hours: 1,
    pollSeconds: 1,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(c.sleeps, [10_000]);
  await assert.rejects(
    waitForExternalInbox({ fetch: async () => [], hours: 0 }),
    /--wait-hours/,
  );
  await assert.rejects(
    waitForExternalInbox({
      fetch: async () => [],
      hours: 1,
      pollSeconds: Number.NaN,
    }),
    /--poll/,
  );
});

test("retries a failed check, but not forever", async () => {
  const c = clock();
  const errors: unknown[] = [];
  let first = true;
  const r = await waitForExternalInbox({
    fetch: async () => {
      if (first) {
        first = false;
        throw new Error("unreachable");
      }
      return [message("m")];
    },
    hours: 1,
    onError: (e) => errors.push(e),
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.messages.length, 1);
  assert.equal(errors.length, 1);
  let calls = 0;
  const c2 = clock();
  await assert.rejects(
    waitForExternalInbox({
      fetch: async () => {
        calls++;
        throw new Error("profile revoked");
      },
      hours: 24,
      now: c2.now,
      sleep: c2.sleep,
    }),
    /profile revoked/,
  );
  assert.equal(calls, INBOX_WAIT_MAX_FAILURES);
});

test("the summary shows short previews and the next step, not whole messages", () => {
  const s = inboxWakeSummary(
    [
      message("m1", "x".repeat(500)),
      { ...message("m2"), attachments: [{ name: "a.md" }] },
    ],
    "alpha",
    false,
  );
  assert.equal(s.pending, 2);
  assert.equal(s.messages[0].preview.length, 201);
  assert.equal(s.messages[1].preview, "hello");
  assert.equal(s.messages[1].attachments, 1);
  assert.match(s.next, /agent inbox --external-agent alpha/);
  assert.match(
    inboxWakeSummary([], "alpha", true).next,
    /sensor watch inbox --external-agent alpha/,
  );
});
