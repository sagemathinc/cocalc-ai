/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// When delivery passes run: an idle hub quiets down, a kick (a login) is
// served at once, a retry runs when it is due, and a database outage backs
// off and is logged once, not once a second.

let dueInMs: number | null = null;
let down = false;
const query = jest.fn(async (sql: string) => {
  if (down) throw new Error("database unavailable");
  if (sql.includes("EXTRACT(EPOCH")) {
    return { rows: [{ ms: dueInMs }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
const connect = jest.fn(async () => {
  if (down) throw new Error("database unavailable");
  return { query, release: jest.fn() };
});
let settings: { computers_enabled?: boolean } = {};
const log = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query, connect }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => log,
}));
jest.mock("./relay", () => ({ HUB_PROCESS: "hub-test", hubClient: jest.fn() }));
jest.mock("./state", () => ({ computerStateSnapshot: jest.fn() }));

import {
  IDLE_POLL_MS,
  LOGIN_DELIVERY_DELAY_MS,
  MAX_ERROR_BACKOFF_MS,
  MIN_POLL_MS,
  kickComputerStateDelivery,
  kickComputerStateDeliveryAfterLogin,
  nextComputerStateDeliveryDelayForTesting as nextDelay,
  nextPassDelay,
  startComputerStateDelivery,
  stopComputerStateDelivery,
} from "./delivery";
import { FailureLog } from "./failure-log";

const MINUTE = 60_000;
/** Each pass claims in one transaction: one connect per pass. */
const passes = () => connect.mock.calls.length;

describe("nextPassDelay", () => {
  it("idles when nothing is owed or computers are off", () => {
    expect(nextPassDelay({ enabled: true, failures: 0, dueInMs: null })).toBe(
      IDLE_POLL_MS,
    );
    expect(nextPassDelay({ enabled: false, failures: 0, dueInMs: 0 })).toBe(
      IDLE_POLL_MS,
    );
  });

  it("runs when the earliest target is due, within bounds", () => {
    expect(nextPassDelay({ enabled: true, failures: 0, dueInMs: 0 })).toBe(
      MIN_POLL_MS,
    );
    expect(nextPassDelay({ enabled: true, failures: 0, dueInMs: 4000 })).toBe(
      4000,
    );
    expect(
      nextPassDelay({ enabled: true, failures: 0, dueInMs: 10 * MINUTE }),
    ).toBe(IDLE_POLL_MS);
  });

  it("backs off after failures", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 50].map((failures) =>
      nextPassDelay({ enabled: true, failures, dueInMs: 0 }),
    );
    expect(delays).toEqual([
      1000,
      2000,
      4000,
      8000,
      16000,
      MAX_ERROR_BACKOFF_MS,
      MAX_ERROR_BACKOFF_MS,
      MAX_ERROR_BACKOFF_MS,
    ]);
  });
});

describe("FailureLog", () => {
  it("logs the first failure, a summary every few minutes, and recovery", () => {
    let t = 0;
    const out = { warn: jest.fn(), info: jest.fn() };
    const f = new FailureLog(out, "work", 5 * MINUTE, () => t);
    f.succeeded();
    expect(out.info).not.toHaveBeenCalled();
    for (; t < 12 * MINUTE; t += 1000) f.failed(new Error("down"));
    // At 0, 5 and 10 minutes: three lines for 720 failures.
    expect(out.warn).toHaveBeenCalledTimes(3);
    expect(out.warn.mock.calls[2][1]).toMatchObject({ failures: 601 });
    f.succeeded();
    expect(out.info).toHaveBeenCalledTimes(1);
    expect(out.info.mock.calls[0][1]).toMatchObject({ failures: 720 });
    f.failed(new Error("again"));
    expect(out.warn).toHaveBeenCalledTimes(4);
  });
});

describe("delivery schedule", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    query.mockClear();
    connect.mockClear();
    log.warn.mockClear();
    log.info.mockClear();
    settings = { computers_enabled: true };
    dueInMs = null;
    down = false;
    startComputerStateDelivery();
  });
  afterEach(() => {
    stopComputerStateDelivery();
    jest.useRealTimers();
  });

  it("an idle hub makes a pass every 30 s, not every second", async () => {
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    // The first pass after a second, then one every 30 s: 20 in 10 minutes
    // (it was 600).
    expect(passes()).toBe(20);
    expect(nextDelay()).toBe(IDLE_POLL_MS);
  });

  it("makes no query at all while computers are off", async () => {
    settings = {};
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    await kickComputerStateDelivery();
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("a kick (a revocation) is served at once, not at the next poll", async () => {
    await jest.advanceTimersByTimeAsync(2 * 1000);
    expect(passes()).toBe(1);
    await kickComputerStateDelivery();
    expect(passes()).toBe(2);
    expect(nextDelay()).toBe(IDLE_POLL_MS);
  });

  it("a login is served a second later, not at the next poll", async () => {
    await jest.advanceTimersByTimeAsync(2 * 1000);
    expect(passes()).toBe(1);
    kickComputerStateDeliveryAfterLogin();
    await jest.advanceTimersByTimeAsync(LOGIN_DELIVERY_DELAY_MS - 1);
    expect(passes()).toBe(1);
    // Its first attempt finds no subscriber yet: due again in 250 ms.
    dueInMs = MIN_POLL_MS;
    await jest.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2);
    expect(nextDelay()).toBe(MIN_POLL_MS);
    dueInMs = null;
    await jest.advanceTimersByTimeAsync(MIN_POLL_MS);
    expect(passes()).toBe(3);
    expect(nextDelay()).toBe(IDLE_POLL_MS);
  });

  it("kicks during a pass coalesce into one more pass", async () => {
    await jest.advanceTimersByTimeAsync(2 * 1000);
    const before = passes();
    const kicks = [1, 2, 3, 4, 5].map(() => kickComputerStateDelivery());
    await Promise.all(kicks);
    expect(passes() - before).toBe(2);
  });

  it("backs off while the database is away and logs it once", async () => {
    down = true;
    await jest.advanceTimersByTimeAsync(4 * MINUTE);
    // 1, 2, 4, 8, 16 s, then every 30 s: about 12 passes, not 240.
    expect(connect.mock.calls.length + query.mock.calls.length).toBeLessThan(
      15,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    down = false;
    await jest.advanceTimersByTimeAsync(MAX_ERROR_BACKOFF_MS);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatch(/recovered/);
    expect(nextDelay()).toBe(IDLE_POLL_MS);
  });
});
