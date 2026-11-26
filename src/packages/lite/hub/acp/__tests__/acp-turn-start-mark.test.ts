/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  acpThreadTurnStartMark,
  finalizeAcpTurnLease,
  startAcpTurnLease,
} from "../../sqlite/acp-turns";

const thread = {
  project_id: "project-mark",
  path: "agent.chat",
  thread_id: "thread-mark",
};

function startTurn(message_date: string) {
  startAcpTurnLease({
    context: {
      ...thread,
      message_date,
      message_id: `message-${message_date}`,
      sender_id: "account",
    } as any,
    owner_instance_id: "worker",
    pid: 1,
    approver_account_id: "account",
  });
  return { project_id: thread.project_id, path: thread.path, message_date };
}

describe("acpThreadTurnStartMark", () => {
  // Table modules initialize once per process: one database for the file.
  beforeAll(() => initAcpDatabase({ filename: ":memory:" }));
  afterAll(() => closeAcpDatabase());

  it("changes when a turn of the thread starts, even one that already ended", () => {
    const empty = acpThreadTurnStartMark(thread);
    const key = startTurn("2026-11-26T00:00:00.000Z");
    const first = acpThreadTurnStartMark(thread);
    expect(first).not.toBe(empty);
    // Ending a turn does not change it.
    finalizeAcpTurnLease({ key, state: "completed" });
    expect(acpThreadTurnStartMark(thread)).toBe(first);
    // A turn that starts and ends between two reads does.
    const second = startTurn("2026-11-26T00:01:00.000Z");
    finalizeAcpTurnLease({ key: second, state: "completed" });
    expect(acpThreadTurnStartMark(thread)).not.toBe(first);
  });

  it("changes even when the clock goes back or repeats", () => {
    const now = jest.spyOn(Date, "now");
    try {
      now.mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
      const key = startTurn("2026-11-26T01:00:00.000Z");
      const late = acpThreadTurnStartMark(thread);
      // A later turn whose start time is below the earlier maximum.
      now.mockReturnValue(Date.parse("2026-11-26T01:00:00Z"));
      startTurn("2026-11-26T01:01:00.000Z");
      const back = acpThreadTurnStartMark(thread);
      expect(back).not.toBe(late);
      // The same lease row restarted in the same millisecond.
      startTurn(key.message_date);
      expect(acpThreadTurnStartMark(thread)).not.toBe(back);
    } finally {
      now.mockRestore();
    }
  });

  it("counts lease starts written by the turn ledger too", () => {
    const before = acpThreadTurnStartMark(thread);
    getAcpDatabase()
      .prepare(
        `INSERT INTO acp_turns (project_id, path, message_date, thread_id, state, owner_instance_id, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'running', 'w', 1, 1)`,
      )
      .run(
        thread.project_id,
        thread.path,
        "2026-11-26T02:00:00.000Z",
        thread.thread_id,
      );
    expect(acpThreadTurnStartMark(thread)).not.toBe(before);
  });

  it("ignores turns of other threads", () => {
    const before = acpThreadTurnStartMark(thread);
    startAcpTurnLease({
      context: {
        ...thread,
        thread_id: "other-thread",
        message_date: "2026-11-26T00:02:00.000Z",
        sender_id: "account",
      } as any,
      owner_instance_id: "worker",
      pid: 1,
      approver_account_id: "account",
    });
    expect(acpThreadTurnStartMark(thread)).toBe(before);
  });
});
