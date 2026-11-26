/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";
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
