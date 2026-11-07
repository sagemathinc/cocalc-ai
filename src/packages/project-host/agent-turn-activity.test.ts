jest.mock("./last-edited", () => ({ touchProjectActivity: jest.fn() }));

import {
  AgentTurnActivity,
  startAgentTurnActivity,
} from "./agent-turn-activity";
import type { AgentTurnRead } from "./agent-turns";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const MIN = 60_000;

function setup() {
  let clock = 1_800_000_000_000;
  let live = new Set<string>();
  let ended = new Set<string>();
  let fail = false;
  const reads: Array<{ now: number; endedAfter: number }> = [];
  const touches: Array<[string, boolean]> = [];
  const activity = new AgentTurnActivity({
    now: () => clock,
    read: (opts): AgentTurnRead => {
      reads.push(opts);
      if (fail) return { ok: false };
      const result: AgentTurnRead = {
        ok: true,
        projects: new Map(
          [...live].map((id) => [id, { started_at: clock - MIN, leases: 1 }]),
        ),
        ended,
        ended_cursor: opts.now,
        invalid: 0,
      };
      ended = new Set();
      return result;
    },
    touch: (project_id, { summary }) => touches.push([project_id, summary]),
    updateMs: 5 * MIN,
    summaryMs: 30 * MIN,
    scanMs: MIN,
  });
  return {
    activity,
    touches,
    reads,
    advance: (ms: number) => (clock += ms),
    setLive: (...ids: string[]) => (live = new Set(ids)),
    setEnded: (...ids: string[]) => (ended = new Set(ids)),
    setFail: (value: boolean) => (fail = value),
    clock: () => clock,
  };
}

test("a turn's first scan touches with the summary; then last_edited every 5 min and the summary every 30 min", () => {
  const t = setup();
  t.setLive(P);
  t.activity.scan();
  expect(t.touches).toEqual([[P, true]]);
  for (let minute = 1; minute <= 30; minute++) {
    t.advance(MIN);
    t.activity.scan();
  }
  // minutes 5, 10, 15, 20, 25 without the summary, minute 30 with it
  expect(t.touches).toEqual([
    [P, true],
    [P, false],
    [P, false],
    [P, false],
    [P, false],
    [P, false],
    [P, true],
  ]);
});

test("when the turn ends, one final touch with the summary, then nothing", () => {
  const t = setup();
  t.setLive(P);
  t.activity.scan();
  t.advance(MIN);
  t.setLive();
  t.setEnded(P);
  t.activity.scan();
  expect(t.touches).toEqual([
    [P, true],
    [P, true],
  ]);
  t.advance(10 * MIN);
  t.activity.scan();
  expect(t.touches).toHaveLength(2);
  expect(t.activity.activeCount()).toBe(0);
});

test("a turn shorter than a scan still gets one touch with the summary", () => {
  const t = setup();
  t.setEnded(P);
  t.activity.scan();
  expect(t.touches).toEqual([[P, true]]);
});

test("several ended leases of a project, or one ending while another runs, give no burst", () => {
  const t = setup();
  // P: two leases ended this scan (the reader dedupes them into one id).
  t.setEnded(P);
  // Q: one lease ended while another of Q's turns still runs.
  t.setLive(Q);
  t.activity.scan();
  t.setEnded(Q);
  t.advance(MIN);
  t.activity.scan();
  expect(t.touches).toEqual([
    [Q, true], // Q's running turn, first seen
    [P, true], // P's final
  ]);
  // Q is still running: no final for it yet.
  expect(t.activity.activeCount()).toBe(1);
});

test("a failed read touches nothing and keeps the cursor; the next good scan catches up", () => {
  const t = setup();
  t.activity.scan();
  const cursor = t.reads[0].now;
  t.advance(MIN);
  t.setFail(true);
  t.activity.scan();
  t.advance(MIN);
  t.activity.scan();
  expect(t.activity.readFailures).toBe(2);
  expect(t.reads[1].endedAfter).toBe(cursor);
  expect(t.reads[2].endedAfter).toBe(cursor);
  t.setFail(false);
  t.setEnded(P); // ended while the reads were failing
  t.advance(MIN);
  t.activity.scan();
  expect(t.reads[3].endedAfter).toBe(cursor);
  expect(t.touches).toEqual([[P, true]]);
});

test("touches continue for as long as the lease stays fresh (no age limit)", () => {
  const t = setup();
  t.setLive(P);
  for (let minute = 0; minute <= 10 * 60; minute++) {
    t.activity.scan();
    t.advance(MIN);
  }
  // 1 first + 120 five-minute touches over 10 h
  expect(t.touches).toHaveLength(121);
  expect(t.touches.filter(([, summary]) => summary)).toHaveLength(21);
});

test("startAgentTurnActivity scans at once and stop() clears the timer", () => {
  jest.useFakeTimers();
  try {
    const read = jest.fn(
      (): AgentTurnRead => ({
        ok: true,
        projects: new Map(),
        ended: new Set(),
        ended_cursor: Date.now(),
        invalid: 0,
      }),
    );
    const { stop } = startAgentTurnActivity({
      read,
      touch: jest.fn(),
      scanMs: MIN,
    });
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(MIN);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    jest.advanceTimersByTime(10 * MIN);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
