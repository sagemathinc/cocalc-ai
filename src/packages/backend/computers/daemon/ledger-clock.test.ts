/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HubClock, SessionClock, type Clocks } from "./clock";
import { Ledger, LedgerConflict } from "./ledger";

describe("the operation ledger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "computer-ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = (operation_id = randomUUID(), request_hash = "sha256:a") => ({
    operation_id,
    operation: "exec" as const,
    request_hash,
    ticket_id: randomUUID(),
    agent_id: "agent-1",
    source_project_id: randomUUID(),
  });

  it("records an operation once; a retry gets the entry back, never a second one", () => {
    const ledger = new Ledger(dir);
    const e = entry();
    const first = ledger.begin(e, 1000);
    expect(first.fresh).toBe(true);
    expect(first.entry.state).toBe("admitted");
    ledger.update(e.operation_id, { state: "done", exit_code: 0 }, 2000);
    const retry = ledger.begin({ ...e, ticket_id: randomUUID() }, 3000);
    expect(retry.fresh).toBe(false);
    expect(retry.entry).toMatchObject({ state: "done", exit_code: 0 });
    expect(readdirSync(join(dir, "ledger"))).toEqual([
      `${e.operation_id}.json`,
    ]);
  });

  it("refuses the same operation_id for another request or another agent", () => {
    const ledger = new Ledger(dir);
    const e = entry();
    ledger.begin(e);
    expect(() => ledger.begin({ ...e, request_hash: "sha256:b" })).toThrow(
      LedgerConflict,
    );
    expect(() => ledger.begin({ ...e, agent_id: "agent-2" })).toThrow(
      LedgerConflict,
    );
  });

  it("marks what was in flight at a crash as unknown, and keeps finished entries", () => {
    const ledger = new Ledger(dir);
    const admitted = entry();
    const running = entry();
    const finished = entry();
    ledger.begin(admitted);
    ledger.begin(running);
    ledger.update(running.operation_id, { state: "running" });
    ledger.begin(finished);
    ledger.update(finished.operation_id, { state: "done" });
    // A new process opens the same directory.
    const after = new Ledger(dir);
    expect(after.markInterrupted().sort()).toEqual(
      [admitted.operation_id, running.operation_id].sort(),
    );
    expect(after.get(admitted.operation_id)!.state).toBe("unknown");
    expect(after.get(running.operation_id)!.state).toBe("unknown");
    expect(after.get(finished.operation_id)!.state).toBe("done");
  });

  it("prunes old finished entries only", () => {
    const ledger = new Ledger(dir);
    const old = entry();
    const open = entry();
    ledger.begin(old, 0);
    ledger.update(old.operation_id, { state: "done" }, 0);
    ledger.begin(open, 0);
    expect(ledger.prune(1000, 10_000)).toBe(1);
    expect(ledger.get(old.operation_id)).toBeUndefined();
    expect(ledger.get(open.operation_id)).toBeDefined();
  });

  it("refuses an operation_id that isn't a uuid (no path tricks)", () => {
    const ledger = new Ledger(dir);
    expect(() => ledger.get("../../etc/passwd")).toThrow(/bad operation_id/);
  });
});

describe("time on the computer", () => {
  function fakeClocks() {
    const t = { wall: 1_000_000, continuous: 50 };
    const clocks: Clocks = {
      wall: () => t.wall,
      continuous: () => t.continuous,
    };
    return { t, clocks };
  }
  const HOUR = 3600_000;

  it("ends the session on time", () => {
    const { t, clocks } = fakeClocks();
    const session = new SessionClock(clocks, {
      deadline_ms: HOUR,
      max_ms: 8 * HOUR,
    });
    t.wall += HOUR - 1;
    t.continuous += HOUR - 1;
    expect(session.ended()).toBe(false);
    t.wall += 1;
    t.continuous += 1;
    expect(session.ended()).toBe(true);
  });

  it("setting the wall clock back doesn't extend it: the monotonic clock still runs", () => {
    const { t, clocks } = fakeClocks();
    const session = new SessionClock(clocks, {
      deadline_ms: HOUR,
      max_ms: HOUR,
    });
    t.wall -= 10 * HOUR;
    t.continuous += HOUR;
    expect(session.ended()).toBe(true);
  });

  it("sleeping doesn't extend it either: the wall clock still runs", () => {
    const { t, clocks } = fakeClocks();
    const session = new SessionClock(clocks, {
      deadline_ms: HOUR,
      max_ms: HOUR,
    });
    t.wall += HOUR; // the monotonic clock didn't count the suspend
    expect(session.ended()).toBe(true);
  });

  it("extends within max_duration only, and never moves the deadline earlier", () => {
    const { t, clocks } = fakeClocks();
    const session = new SessionClock(clocks, {
      deadline_ms: HOUR,
      max_ms: 8 * HOUR,
    });
    expect(session.extendTo(100 * HOUR)).toBe(8 * HOUR);
    expect(session.extendTo(2 * HOUR)).toBe(8 * HOUR);
    t.wall += 8 * HOUR;
    expect(session.ended()).toBe(true);
    // A far-future signed time changes nothing past the max.
    expect(session.extendTo(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("has no deadline without a limit", () => {
    const { t, clocks } = fakeClocks();
    const session = new SessionClock(clocks, {
      deadline_ms: null,
      max_ms: null,
    });
    t.wall += 1000 * HOUR;
    expect(session.remainingMs()).toBeNull();
    expect(session.ended()).toBe(false);
  });

  it("lets the hub time offset move only a little between connections", () => {
    const { t, clocks } = fakeClocks();
    const hub = new HubClock(clocks, 120_000);
    expect(hub.now()).toBeUndefined();
    expect(hub.observe(5000)).toBe(true);
    expect(hub.now()).toBe(t.wall + 5000);
    expect(hub.observe(5000 + 121_000)).toBe(false);
    expect(hub.now()).toBe(t.wall + 5000);
    expect(hub.observe(5000 - 60_000)).toBe(true);
    expect(hub.observe(Number.NaN)).toBe(false);
  });
});
