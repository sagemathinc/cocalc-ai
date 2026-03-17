#!/usr/bin/env ts-node
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../sqlite/database";
import {
  decodeAcpInterruptCandidateIds,
  decodeAcpInterruptChat,
  enqueueAcpInterrupt,
  listPendingAcpInterrupts,
  markAcpInterruptError,
  markAcpInterruptHandled,
  markAcpInterruptsHandledForThread,
} from "../../sqlite/acp-interrupts";

beforeAll(() => {
  closeDatabase();
  initDatabase({ filename: ":memory:" });
  listPendingAcpInterrupts();
});

beforeEach(() => {
  getDatabase().prepare("DELETE FROM acp_interrupts").run();
});

afterAll(() => {
  closeDatabase();
});

describe("acp interrupt queue", () => {
  it("stores interrupt requests durably with candidate ids and chat context", () => {
    const row = enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-1",
      candidate_ids: ["thread-1", "session-1", ""],
      chat: {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/acp.chat",
        thread_id: "thread-1",
        message_date: "2026-03-08T00:00:00.000Z",
        sender_id: "00000000-1000-4000-8000-000000000001",
      },
    });
    const pending = listPendingAcpInterrupts();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(row.id);
    expect(decodeAcpInterruptCandidateIds(pending[0])).toEqual([
      "thread-1",
      "session-1",
    ]);
    expect(decodeAcpInterruptChat(pending[0])?.thread_id).toBe("thread-1");
  });

  it("deduplicates repeated pending interrupts for the same thread", () => {
    const first = enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-1",
      candidate_ids: ["thread-1"],
      chat: {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/acp.chat",
        thread_id: "thread-1",
        message_date: "2026-03-08T00:00:00.000Z",
        sender_id: "00000000-1000-4000-8000-000000000001",
      },
    });
    const second = enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-1",
      candidate_ids: ["session-1"],
    });

    const pending = listPendingAcpInterrupts();
    expect(pending).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(decodeAcpInterruptCandidateIds(pending[0])).toEqual([
      "thread-1",
      "session-1",
    ]);
  });

  it("transitions pending rows to handled or error", () => {
    const handled = enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-2",
      candidate_ids: ["thread-2"],
    });
    const errored = enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-3",
      candidate_ids: ["thread-3"],
    });
    markAcpInterruptHandled({ id: handled.id });
    markAcpInterruptError({
      id: errored.id,
      error: "unable to interrupt codex session",
    });
    const pending = listPendingAcpInterrupts();
    expect(pending.map((row) => row.id)).toEqual([]);
  });

  it("can clear all pending interrupts for one thread after a direct interrupt succeeds", () => {
    enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-4",
      candidate_ids: ["thread-4"],
    });
    enqueueAcpInterrupt({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-5",
      candidate_ids: ["thread-5"],
    });

    markAcpInterruptsHandledForThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-4",
    });

    const pending = listPendingAcpInterrupts();
    expect(pending).toHaveLength(1);
    expect(pending[0].thread_id).toBe("thread-5");
  });
});
