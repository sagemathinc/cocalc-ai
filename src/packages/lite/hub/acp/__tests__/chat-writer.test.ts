#!/usr/bin/env ts-node
import { setTimeout as delay } from "node:timers/promises";
import type {
  AcpChatContext,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { ChatStreamWriter, recoverOrphanedAcpTurns } from "../index";
import * as queue from "../../sqlite/acp-queue";
import * as turns from "../../sqlite/acp-turns";
import * as chatServer from "@cocalc/chat/server";

// Mock ACP pieces that pull in ESM deps we don't need for this unit.
jest.mock("@cocalc/ai/acp", () => ({
  CodexAcpAgent: class {},
  EchoAgent: class {},
}));
jest.mock("@cocalc/conat/ai/acp/server", () => ({ init: async () => {} }));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));
jest.mock("../../sqlite/acp-queue", () => ({
  enqueueAcpPayload: jest.fn(),
  listAcpPayloads: jest.fn(() => []),
  clearAcpPayloads: jest.fn(),
}));
jest.mock("../../sqlite/acp-turns", () => ({
  startAcpTurnLease: jest.fn(),
  heartbeatAcpTurnLease: jest.fn(),
  finalizeAcpTurnLease: jest.fn(),
  updateAcpTurnLeaseSessionId: jest.fn(),
  listRunningAcpTurnLeases: jest.fn(() => []),
}));
jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(),
  releaseChatSyncDB: jest.fn(),
}));

type RecordedSet = { generating?: boolean; content?: string };

function makeFakeSyncDB() {
  const sets: RecordedSet[] = [];
  let commits = 0;
  let saves = 0;
  let current: any;
  const syncdb: any = {
    metadata: baseMetadata,
    isReady: () => true,
    get_one: () => current,
    set: (val: any) => {
      sets.push(val);
      current = { ...(current ?? {}), ...val };
    },
    commit: () => {
      commits += 1;
    },
    save: async () => {
      saves += 1;
    },
    close: async () => {},
  };
  return {
    syncdb,
    sets,
    commits,
    saves,
    setCurrent: (val: any) => {
      current = val;
    },
  };
}

function makeFakeClient(): ConatClient {
  return {
    publish: async () => {},
  } as any;
}

const baseMetadata: AcpChatContext = {
  project_id: "p",
  path: "chat",
  message_date: "123",
  sender_id: "u",
} as any;

beforeEach(() => {
  (queue.listAcpPayloads as any)?.mockReset?.();
  (queue.listAcpPayloads as any)?.mockImplementation?.(() => []);
  (queue.enqueueAcpPayload as any)?.mockReset?.();
  (queue.clearAcpPayloads as any)?.mockReset?.();
  (turns.startAcpTurnLease as any)?.mockReset?.();
  (turns.heartbeatAcpTurnLease as any)?.mockReset?.();
  (turns.finalizeAcpTurnLease as any)?.mockReset?.();
  (turns.updateAcpTurnLeaseSessionId as any)?.mockReset?.();
  (turns.listRunningAcpTurnLeases as any)?.mockReset?.();
  (turns.listRunningAcpTurnLeases as any)?.mockImplementation?.(() => []);
  (chatServer.acquireChatSyncDB as any)?.mockReset?.();
  (chatServer.releaseChatSyncDB as any)?.mockReset?.();
  (chatServer.releaseChatSyncDB as any)?.mockResolvedValue?.(undefined);
});

async function flush(writer: ChatStreamWriter) {
  (writer as any).commit.flush();
  await delay(0);
}

describe("ChatStreamWriter", () => {
  it("clears generating on summary", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "hi" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    (writer as any).dispose?.(true);
  });

  it("keeps usage but commits final state", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "usage",
      usage: { tokens: 1 } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    expect((writer as any).usage).toBeTruthy();
    (writer as any).dispose?.(true);
  });

  it("replays queued payloads without losing content", async () => {
    (queue.listAcpPayloads as any).mockReturnValue([
      {
        type: "event",
        event: { type: "message", text: "queued" },
        seq: 0,
      },
    ]);
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    await (writer as any).handle({
      type: "summary",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);
    expect((queue.enqueueAcpPayload as any).mock.calls.length).toBe(1);
    (writer as any).dispose?.(true);
  });

  it("publishes logs and persists AKV", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const logSet = jest.fn().mockResolvedValue(undefined);
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: { publish } as any,
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: logSet,
        }) as any,
    });
    const payload: AcpStreamMessage = {
      type: "event",
      event: { type: "message", text: "hi" } as any,
      seq: 0,
    };
    await (writer as any).handle(payload);
    (writer as any).persistLogProgress.flush();
    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);
    expect(publish).toHaveBeenCalled();
    expect(logSet).toHaveBeenCalled();
    (writer as any).dispose?.(true);
  });

  it("clears generating and queue on error", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "oops" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "error",
      error: "failed",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    expect((queue.clearAcpPayloads as any).mock.calls.length).toBe(1);
    (writer as any).dispose?.(true);
  });

  it("does not overwrite error content when summary arrives afterward", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "error",
      error: "failed",
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "duplicate failure text",
      threadId: "thread-after-error",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("failed");
    expect((writer as any).content).not.toContain("duplicate failure text");
    expect((writer as any).getKnownThreadIds()).toContain("thread-after-error");
    expect(sets.some((row) => row.generating === false)).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("keeps streamed final message when error arrives before summary", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "final answer text" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "error",
      error: "connection reset",
      seq: 1,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "final answer text",
      threadId: "thread-after-connection-error",
      seq: 2,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("final answer text");
    expect((writer as any).content).not.toContain("connection reset");
    expect((writer as any).getKnownThreadIds()).toContain(
      "thread-after-connection-error",
    );
    (writer as any).dispose?.(true);
  });

  it("addLocalEvent writes an in-flight commit", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    (writer as any).addLocalEvent({
      type: "message",
      text: "local",
    });
    (writer as any).commit.flush();
    await delay(0);

    expect(sets.length).toBeGreaterThan(0);
    expect(sets[sets.length - 1].generating).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("registers thread ids from summary", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      threadId: "thread-1",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).getKnownThreadIds()).toContain("thread-1");
    (writer as any).dispose?.(true);
  });

  it("tracks lease lifecycle from running to completed", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      sessionKey: "thread-seed",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "hello" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      threadId: "thread-1",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect((turns.startAcpTurnLease as any).mock.calls.length).toBe(1);
    expect((turns.heartbeatAcpTurnLease as any).mock.calls.length).toBeGreaterThan(
      0,
    );
    expect((turns.updateAcpTurnLeaseSessionId as any).mock.calls.length).toBeGreaterThan(
      0,
    );
    expect((turns.finalizeAcpTurnLease as any).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            state: "completed",
          }),
        ],
      ]),
    );
    (writer as any).dispose?.(true);
  });

  it("marks lease aborted when disposed before terminal payload", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "still running" } as any,
      seq: 0,
    } as AcpStreamMessage);
    (writer as any).dispose?.(true);

    expect((turns.finalizeAcpTurnLease as any).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            state: "aborted",
          }),
        ],
      ]),
    );
  });

  it("uses interrupted text when summary arrives", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    (writer as any).notifyInterrupted("Please fix X");
    await (writer as any).handle({
      type: "summary",
      finalResponse: "",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("Please fix X");
    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    expect((final as any).acp_interrupted).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("keeps interrupted text when late payloads arrive", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    (writer as any).notifyInterrupted("Please fix X");
    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "late streamed text" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "late final response",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("Please fix X");
    expect((writer as any).content).not.toContain("late streamed text");
    expect((writer as any).content).not.toContain("late final response");
    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    expect((final as any).acp_interrupted).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("concatenates multiple agent messages into final content", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "first" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "second" } as any,
      seq: 1,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "",
      seq: 2,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("first");
    expect((writer as any).content).toContain("second");
    (writer as any).dispose?.(true);
  });

  it("aggregates multiple summary payloads", async () => {
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "summary",
      finalResponse: "Hello",
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: " world",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain("Hello");
    expect((writer as any).content).toContain("world");
    (writer as any).dispose?.(true);
  });
});

describe("recoverOrphanedAcpTurns", () => {
  it("marks stale generating turn as interrupted with restart notice", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      event: "chat",
      date: "123",
      generating: true,
      history: [
        {
          author_id: "codex-agent",
          content: "partial answer",
          date: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "p",
        path: "chat",
        message_date: "123",
        sender_id: "codex-agent",
        reply_to: null,
      },
    ]);

    const recovered = await recoverOrphanedAcpTurns(makeFakeClient() as any);

    expect(recovered).toBe(1);
    const final = sets[sets.length - 1] as any;
    expect(final.generating).toBe(false);
    expect(final.acp_interrupted).toBe(true);
    expect(final.acp_interrupted_reason).toBe("server_restart");
    expect(final.history?.[0]?.content).toContain(
      "Conversation interrupted because the backend server restarted.",
    );
    expect((queue.clearAcpPayloads as any).mock.calls.length).toBe(1);
    expect((turns.finalizeAcpTurnLease as any).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            state: "aborted",
            reason: "server restart recovery",
          }),
        ],
      ]),
    );
  });
});
