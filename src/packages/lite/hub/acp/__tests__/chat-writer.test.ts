#!/usr/bin/env ts-node
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  AcpChatContext,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { CHAT_THREAD_META_ROW_DATE, threadConfigSenderId } from "@cocalc/chat";
import {
  ChatStreamWriter,
  disposeAllChatWritersForTests,
  recoverCurrentWorkerStuckAcpTurns,
  recoverOrphanedAcpTurns,
  repairInterruptedAcpTurn,
} from "../index";
import * as queue from "../../sqlite/acp-queue";
import * as turns from "../../sqlite/acp-turns";
import * as chatServer from "@cocalc/chat/server";
import { rotateChatStore } from "@cocalc/backend/chat-store/sqlite-offload";

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
jest.mock("@cocalc/project/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    extend: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      extend: () => ({}),
    }),
  }),
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    extend: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      extend: () => ({}),
    }),
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
jest.mock("@cocalc/backend/chat-store/sqlite-offload", () => ({
  rotateChatStore: jest.fn(async () => ({ rotated: false })),
}));

type RecordedSet = {
  generating?: boolean;
  content?: string;
  history?: unknown;
  acp_account_id?: string;
  acp_started_at_ms?: number;
  acp_log_store?: string;
  acp_log_key?: string;
  acp_log_subject?: string;
  acp_live_log_stream?: string;
  acp_live_preview_stream?: string;
  message_id?: string;
};

function makeFakeSyncDB() {
  const sets: RecordedSet[] = [];
  let commits = 0;
  let saves = 0;
  let versions = 0;
  const rows: any[] = [];
  const rowKey = (value: any): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (value.event === "chat" && value.message_id) {
      return `chat:${value.message_id}`;
    }
    if (value.event && value.thread_id) {
      return `${value.event}:${value.thread_id}`;
    }
    if (value.event && value.date && value.sender_id) {
      return `${value.event}:${value.date}:${value.sender_id}`;
    }
    return undefined;
  };
  const matchWhere = (row: any, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => row?.[key] === value);
  const syncdb: any = {
    metadata: baseMetadata,
    isReady: () => true,
    get_one: (where?: Record<string, unknown>) => {
      if (!where) return rows[rows.length - 1];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matchWhere(rows[i], where)) return rows[i];
      }
      return undefined;
    },
    get: (where?: Record<string, unknown>) => {
      if (!where) return rows.slice();
      return rows.filter((row) => matchWhere(row, where));
    },
    set: (val: any) => {
      sets.push(val);
      const key = rowKey(val);
      if (!key) {
        rows.push({ ...val });
        return;
      }
      const index = rows.findIndex((row) => rowKey(row) === key);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...val };
      } else {
        rows.push({ ...val });
      }
    },
    commit: () => {
      commits += 1;
      versions += 1;
    },
    save: async () => {
      saves += 1;
    },
    close: async () => {},
    versions: () => Array.from({ length: versions }, (_, i) => `v${i}`),
  };
  return {
    syncdb,
    sets,
    getCommits: () => commits,
    getSaves: () => saves,
    getVersions: () => versions,
    setCurrent: (val: any) => {
      rows.length = 0;
      if (val != null) {
        rows.push(val);
      }
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
  started_at_ms: 1234,
  message_id: "msg-0",
  thread_id: "thread-0",
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
  (rotateChatStore as any)?.mockReset?.();
  (rotateChatStore as any)?.mockResolvedValue?.({ rotated: false });
});

afterEach(async () => {
  await disposeAllChatWritersForTests();
});

async function flush(writer: ChatStreamWriter) {
  (writer as any).commit.flush();
  await delay(0);
}

function flattenLivePayloads(
  payloads: Array<AcpStreamMessage | AcpStreamMessage[]>,
): AcpStreamMessage[] {
  return payloads.flatMap((payload) =>
    Array.isArray(payload) ? payload : [payload],
  );
}

describe("ChatStreamWriter", () => {
  it("requires thread_id in metadata", async () => {
    const { syncdb } = makeFakeSyncDB();
    expect(
      () =>
        new ChatStreamWriter({
          metadata: {
            ...baseMetadata,
            thread_id: undefined,
          } as any,
          client: makeFakeClient(),
          approverAccountId: "u",
          syncdbOverride: syncdb as any,
          logStoreFactory: () =>
            ({
              set: async () => {},
            }) as any,
        }),
    ).toThrow("missing required thread_id");
  });

  it("requires message_id in metadata", async () => {
    const { syncdb } = makeFakeSyncDB();
    expect(
      () =>
        new ChatStreamWriter({
          metadata: {
            ...baseMetadata,
            message_id: undefined,
          } as any,
          client: makeFakeClient(),
          approverAccountId: "u",
          syncdbOverride: syncdb as any,
          logStoreFactory: () =>
            ({
              set: async () => {},
            }) as any,
        }),
    ).toThrow("missing required message_id");
  });

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

  it("stamps ACP activity markers on the startup placeholder row", async () => {
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
    await writer.waitUntilReady();

    const placeholder = sets.find((row: any) => row.message_id === "msg-0");
    expect(placeholder?.acp_account_id).toBe("u");
    expect(placeholder?.acp_started_at_ms).toBe(1234);
    expect(placeholder?.acp_log_store).toBeTruthy();
    expect(placeholder?.acp_log_key).toBeTruthy();
    expect(placeholder?.acp_log_subject).toBeTruthy();
    expect(placeholder?.acp_live_log_stream).toBeTruthy();
    expect(placeholder?.acp_live_preview_stream).toBeTruthy();
    (writer as any).dispose?.(true);
  });

  it("updates an existing queued placeholder with actual ACP start time", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      event: "chat",
      sender_id: "u",
      date: "123",
      message_id: "msg-0",
      thread_id: "thread-0",
      generating: true,
      history: [
        { author_id: "u", content: ":robot: Thinking...", date: "123" },
      ],
      get(key: string) {
        return (this as any)[key];
      },
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
    await writer.waitUntilReady();

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "still working" } as any,
      seq: 0,
    } as AcpStreamMessage);

    const startedAtUpdate = sets.find(
      (row: any) =>
        row.message_id === "msg-0" &&
        row.generating === true &&
        row.acp_started_at_ms === 1234,
    );
    expect(startedAtUpdate).toBeTruthy();
    (writer as any).dispose?.(true);
  });

  it("does not durably rewrite chat rows for streaming events", async () => {
    const { syncdb, setCurrent, getCommits, getSaves } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => {
        if (key === "generating") return true;
        if (key === "acp_started_at_ms") return 1234;
        return undefined;
      },
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
    await writer.waitUntilReady();
    const commitsBefore = getCommits();
    const savesBefore = getSaves();

    await writer.handle({
      type: "event",
      event: { type: "message", text: "streamed text" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    expect(getCommits()).toBe(commitsBefore);
    expect(getSaves()).toBe(savesBefore);
    (writer as any).dispose?.(true);
  });

  it("keeps the writer-side patchflow version budget bounded", async () => {
    const { syncdb, getVersions } = makeFakeSyncDB();
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
    await writer.waitUntilReady();
    const baseline = getVersions();

    await writer.handle({
      type: "status",
      state: "init",
      threadId: "thread-live-1",
      seq: 0,
    } as AcpStreamMessage);
    await writer.handle({
      type: "event",
      event: { type: "message", text: "hello" } as any,
      seq: 1,
    } as AcpStreamMessage);
    await writer.handle({
      type: "event",
      event: { type: "message", text: "hello again" } as any,
      seq: 2,
    } as AcpStreamMessage);
    await writer.handle({
      type: "summary",
      finalResponse: "done",
      seq: 3,
    } as AcpStreamMessage);
    await flush(writer);

    const snapshot = writer.watchdogSnapshot().patchflow;
    expect(snapshot).toEqual(
      expect.objectContaining({
        deltaVersions: expect.any(Number),
        peakDeltaVersions: expect.any(Number),
        target: 6,
        ceiling: 10,
      }),
    );
    expect(snapshot.deltaVersions).toBeLessThanOrEqual(10);
    expect(snapshot.peakDeltaVersions).toBeLessThanOrEqual(10);
    expect(getVersions() - baseline).toBeLessThanOrEqual(10);
    (writer as any).dispose?.(true);
  });

  it("waits for the terminal syncdb save before resolving summary handling", async () => {
    const { syncdb, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    let holdSave = false;
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    syncdb.save = async () => {
      if (holdSave) {
        await saveGate;
      }
    };
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
    await writer.waitUntilReady();
    holdSave = true;
    let resolved = false;
    const pending = writer
      .handle({
        type: "summary",
        finalResponse: "done",
        seq: 0,
      } as AcpStreamMessage)
      .then(() => {
        resolved = true;
      });

    await delay(0);
    expect(resolved).toBe(false);

    releaseSave?.();
    await pending;
    expect(resolved).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("defers autorotate until after the terminal syncdb save settles", async () => {
    const { syncdb, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    let holdSave = false;
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    syncdb.save = async () => {
      if (holdSave) {
        await saveGate;
      }
    };
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acp-autorotate-"));
    const chatPath = path.join(tmp, "live.chat");
    const writer: any = new ChatStreamWriter({
      metadata: {
        ...baseMetadata,
        path: chatPath,
      },
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    await writer.waitUntilReady();
    holdSave = true;

    let resolved = false;
    const pending = writer
      .handle({
        type: "summary",
        finalResponse: "done",
        seq: 0,
      } as AcpStreamMessage)
      .then(() => {
        resolved = true;
      });

    await delay(0);
    expect(resolved).toBe(false);
    expect(rotateChatStore).not.toHaveBeenCalled();

    releaseSave?.();
    await pending;

    expect(resolved).toBe(true);
    expect(rotateChatStore).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_path: chatPath,
      }),
    );
    (writer as any).dispose?.(true);
  });

  it("waits for dispose-triggered syncdb saves before reporting completion", async () => {
    const { syncdb, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    let holdSave = false;
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saves = 0;
    syncdb.save = async () => {
      saves += 1;
      if (holdSave) {
        await saveGate;
      }
    };
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
    await writer.waitUntilReady();
    holdSave = true;
    writer.dispose(true);
    let disposed = false;
    const pending = writer.waitUntilDisposed().then(() => {
      disposed = true;
    });

    await delay(0);
    expect(disposed).toBe(false);
    expect(saves).toBeGreaterThan(0);

    releaseSave?.();
    await pending;
    expect(disposed).toBe(true);
  });

  it("does not write a duplicate terminal assistant patch during dispose", async () => {
    const { syncdb, getVersions } = makeFakeSyncDB();
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

    await writer.handle({
      type: "summary",
      finalResponse: "done",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const versionsAfterSummary = getVersions();
    writer.dispose(true);
    await writer.waitUntilDisposed();

    expect(getVersions()).toBe(versionsAfterSummary);
  });

  it("stamps activity log refs from thread_id and message_id", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      get: (key: string) => (key === "generating" ? true : undefined),
    });
    const metadata: AcpChatContext = {
      ...baseMetadata,
      path: "folder/chat.chat",
      message_id: "assistant-msg-7",
      thread_id: "thread-7",
    } as any;
    const writer: any = new ChatStreamWriter({
      metadata,
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
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1] as any;
    expect(final.acp_log_store).toBe("acp-log/folder/chat.chat");
    expect(final.acp_log_key).toBe("thread-7:assistant-msg-7");
    expect(final.acp_log_subject).toBe(
      "project.p.acp-log.thread-7.assistant-msg-7",
    );
    expect(final.acp_live_log_stream).toBeUndefined();
    (writer as any).dispose?.(true);
  });

  it("publishes live status/events to the ephemeral stream and persists the final log once", async () => {
    const { syncdb } = makeFakeSyncDB();
    const persistedLogs: any[][] = [];
    const livePayloads: Array<AcpStreamMessage | AcpStreamMessage[]> = [];
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: async (_key: string, value: any[]) => {
            persistedLogs.push(value);
          },
        }) as any,
      liveLogStreamFactory: () =>
        ({
          publish: async (payload: AcpStreamMessage | AcpStreamMessage[]) => {
            livePayloads.push(payload);
            return { seq: livePayloads.length, time: Date.now() };
          },
          close: () => {},
        }) as any,
    });

    await writer.handle({
      type: "status",
      state: "running",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);
    await (writer as any).waitForLiveLogFlush();

    await writer.handle({
      type: "event",
      event: { type: "message", text: "hi" } as any,
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);
    await (writer as any).waitForLiveLogFlush();

    const liveEvents = flattenLivePayloads(livePayloads);
    expect(liveEvents).toHaveLength(2);
    expect(liveEvents[0].type).toBe("status");
    expect((liveEvents[0] as any).state).toBe("running");
    expect(liveEvents[1].type).toBe("event");
    expect(persistedLogs).toHaveLength(0);

    await writer.handle({
      type: "summary",
      finalResponse: "done",
      seq: 2,
    } as AcpStreamMessage);
    await flush(writer);

    expect(flattenLivePayloads(livePayloads)).toHaveLength(3);
    expect(persistedLogs).toHaveLength(1);
    expect(persistedLogs[0][0]?.type).toBe("status");
    expect(persistedLogs[0].at(-1)?.type).toBe("summary");
    (writer as any).dispose?.(true);
  });

  it("retries terminal commit verification when generating looks stale", async () => {
    const sets: RecordedSet[] = [];
    let commits = 0;
    let saves = 0;
    let staleReads = 2;
    let current: any = {};
    const syncdb: any = {
      metadata: baseMetadata,
      isReady: () => true,
      get_one: () => {
        if (staleReads > 0) {
          staleReads -= 1;
          return {
            generating: true,
            get: (key: string) => (key === "generating" ? true : undefined),
          };
        }
        return current;
      },
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
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    expect(commits).toBeGreaterThanOrEqual(1);
    expect(saves).toBeGreaterThanOrEqual(1);
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

  it("publishes live logs and persists AKV at terminal", async () => {
    const logSet = jest.fn().mockResolvedValue(undefined);
    const livePublish = jest.fn().mockResolvedValue({
      seq: 1,
      time: Date.now(),
    });
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: logSet,
        }) as any,
      liveLogStreamFactory: () =>
        ({
          publish: livePublish,
          close: () => {},
        }) as any,
    });
    const payload: AcpStreamMessage = {
      type: "event",
      event: { type: "message", text: "hi" } as any,
      seq: 0,
    };
    await (writer as any).handle(payload);
    await flush(writer);
    await (writer as any).waitForLiveLogFlush();
    expect(livePublish).toHaveBeenCalledTimes(1);
    expect(logSet).not.toHaveBeenCalled();
    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);
    expect(livePublish).toHaveBeenCalledTimes(2);
    expect(logSet).toHaveBeenCalled();
    (writer as any).dispose?.(true);
  });

  it("publishes live log events to the ephemeral stream in order", async () => {
    const livePayloads: Array<AcpStreamMessage | AcpStreamMessage[]> = [];
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
      liveLogStreamFactory: () =>
        ({
          publish: async (payload: AcpStreamMessage | AcpStreamMessage[]) => {
            livePayloads.push(payload);
            return { seq: livePayloads.length, time: Date.now() };
          },
          close: () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "Hel" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);
    await writer.handle({
      type: "event",
      event: { type: "message", text: "lo" } as any,
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);
    await (writer as any).waitForLiveLogFlush();

    const liveEvents = flattenLivePayloads(livePayloads);
    expect(liveEvents).toHaveLength(2);
    expect(liveEvents[0]).toMatchObject({ seq: 0, type: "event" });
    expect(liveEvents[1]).toMatchObject({ seq: 1, type: "event" });
    (writer as any).dispose?.(true);
  });

  it("publishes only preview-relevant payloads to the preview stream", async () => {
    const livePayloads: Array<AcpStreamMessage | AcpStreamMessage[]> = [];
    const previewPayloads: Array<AcpStreamMessage | AcpStreamMessage[]> = [];
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
      liveLogStreamFactory: () =>
        ({
          publish: async (payload: AcpStreamMessage | AcpStreamMessage[]) => {
            livePayloads.push(payload);
            return { seq: livePayloads.length, time: Date.now() };
          },
          close: () => {},
        }) as any,
      livePreviewStreamFactory: () =>
        ({
          publish: async (payload: AcpStreamMessage | AcpStreamMessage[]) => {
            previewPayloads.push(payload);
            return { seq: previewPayloads.length, time: Date.now() };
          },
          close: () => {},
        }) as any,
    });

    await writer.handle({
      type: "status",
      state: "running",
      threadId: "thread-0",
      seq: 0,
      time: 1000,
    } as AcpStreamMessage);
    await writer.handle({
      type: "event",
      event: { type: "message", text: "Checking the code path." } as any,
      seq: 1,
      time: 1100,
    } as AcpStreamMessage);
    await writer.handle({
      type: "event",
      event: {
        type: "file",
        path: "src/example.ts",
        operation: "write",
      } as any,
      seq: 2,
      time: 3500,
    } as AcpStreamMessage);
    await writer.handle({
      type: "summary",
      finalResponse: "done",
      seq: 3,
      time: 3600,
    } as AcpStreamMessage);
    await flush(writer);
    await writer.waitForLiveLogFlush();
    await writer.waitForLivePreviewFlush();

    const liveEvents = flattenLivePayloads(livePayloads);
    const previewEvents = flattenLivePayloads(previewPayloads);
    expect(liveEvents.some((event) => event.type === "event")).toBe(true);
    expect(
      previewEvents.some(
        (event) => event.type === "event" && event.event.type === "file",
      ),
    ).toBe(false);
    expect(previewEvents).toEqual([
      expect.objectContaining({
        type: "status",
        state: "running",
        seq: 0,
      }),
      expect.objectContaining({
        type: "event",
        seq: 1,
        event: expect.objectContaining({
          type: "message",
          text: "Checking the code path.",
        }),
      }),
      expect.objectContaining({
        type: "status",
        state: "running",
        seq: 2,
      }),
      expect.objectContaining({
        type: "summary",
        seq: 3,
        finalResponse: "done",
      }),
    ]);
    (writer as any).dispose?.(true);
  });

  it("persists durable timestamps on live and terminal log events", async () => {
    const logSet = jest.fn().mockResolvedValue(undefined);
    const livePayloads: Array<AcpStreamMessage | AcpStreamMessage[]> = [];
    const { syncdb } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb as any,
      logStoreFactory: () =>
        ({
          set: logSet,
        }) as any,
      liveLogStreamFactory: () =>
        ({
          publish: async (payload: AcpStreamMessage | AcpStreamMessage[]) => {
            livePayloads.push(payload);
            return { seq: livePayloads.length, time: Date.now() };
          },
          close: () => {},
        }) as any,
    });

    await (writer as any).handle({
      type: "event",
      event: { type: "message", text: "hi" } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "summary",
      finalResponse: "done",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    const persistedEvents = logSet.mock.calls[0]?.[1];
    const liveEvents = flattenLivePayloads(livePayloads);
    expect(typeof liveEvents?.[0]?.time).toBe("number");
    expect(Array.isArray(persistedEvents)).toBe(true);
    expect(typeof persistedEvents?.[0]?.time).toBe("number");

    (writer as any).dispose?.(true);
  });

  it("preserves existing thread config fields when persisting loop state", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      event: "chat-thread-config",
      sender_id: threadConfigSenderId("thread-0"),
      date: CHAT_THREAD_META_ROW_DATE,
      thread_id: "thread-0",
      name: "Fork of bug fixing",
      acp_config: {
        model: "gpt-5.4",
        reasoning: "extra_high",
        workingDirectory: "/repo",
      },
      updated_at: new Date().toISOString(),
      updated_by: "u",
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

    await writer.persistLoopState({
      loopConfig: { enabled: true, max_turns: 5 },
      loopState: {
        loop_id: "loop-1",
        status: "running",
        started_at_ms: 1,
        updated_at_ms: 2,
        iteration: 1,
      },
    });

    const patched = sets[sets.length - 1] as any;
    expect(patched.name).toBe("Fork of bug fixing");
    expect(patched.acp_config).toEqual({
      model: "gpt-5.4",
      reasoning: "extra_high",
      workingDirectory: "/repo",
    });
    expect(patched.loop_config).toEqual({
      enabled: true,
      max_turns: 5,
    });
    expect(patched.loop_state).toEqual(
      expect.objectContaining({
        loop_id: "loop-1",
        status: "running",
      }),
    );
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

  it("sanitizes usage limit errors and strips podman warning noise", async () => {
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
      error:
        'You have reached your 5-hour LLM usage limit. Please try again later or upgrade your membership. time="2026-03-15T19:28:14Z" level=warning msg="The cgroupv2 manager is set to systemd but there is no systemd user session available" time="2026-03-15T19:28:14Z" level=warning msg="For using systemd, you may need to log in using a user session" time="2026-03-15T19:28:14Z" level=warning msg="Alternatively, you can enable lingering with: loginctl enable-linger 1002 (possibly as root)" time="2026-03-15T19:28:14Z" level=warning msg="Falling back to --cgroup-manager=cgroupfs"',
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const final = sets[sets.length - 1] as any;
    expect(final.generating).toBe(false);
    expect((writer as any).content).toContain("**LLM usage limit reached**");
    expect((writer as any).content).toContain(
      "You have reached your 5-hour LLM usage limit.",
    );
    expect((writer as any).content).toContain("/settings/store");
    expect((writer as any).content).toContain("/settings/preferences/ai");
    expect((writer as any).content).not.toContain(
      "The cgroupv2 manager is set to systemd",
    );
    expect((writer as any).content).not.toContain(
      "Falling back to --cgroup-manager=cgroupfs",
    );
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

  it("addLocalEvent keeps chat-row writes deferred until terminal state", async () => {
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
    await writer.waitUntilReady();
    const setCountBefore = sets.length;
    (writer as any).addLocalEvent({
      type: "message",
      text: "local",
    });
    (writer as any).commit.flush();
    await delay(0);

    expect(sets.length).toBe(setCountBefore);
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

  it("registers live thread ids from status payloads", async () => {
    const { syncdb, sets, getVersions } = makeFakeSyncDB();
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
    await writer.waitUntilReady();
    const versionsBefore = getVersions();

    await (writer as any).handle({
      type: "status",
      state: "init",
      threadId: "thread-live-1",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).getKnownThreadIds()).toContain("thread-live-1");
    expect(getVersions() - versionsBefore).toBe(1);
    const metadataUpdate = sets.find(
      (row: any) =>
        row.message_id === "msg-0" && row.acp_thread_id === "thread-live-1",
    );
    expect(metadataUpdate).toBeTruthy();
    expect(
      sets.find((row: any) => row.event === "chat-thread-config"),
    ).toBeUndefined();
    (writer as any).dispose?.(true);
  });

  it("does not rewrite thread-state for duplicate live running status", async () => {
    const { syncdb, getVersions } = makeFakeSyncDB();
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
    await writer.waitUntilReady();

    await writer.handle({
      type: "status",
      state: "running",
      threadId: "thread-live-1",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);
    const versionsAfterFirst = getVersions();

    await writer.handle({
      type: "status",
      state: "running",
      threadId: "thread-live-1",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect(getVersions()).toBe(versionsAfterFirst);
    (writer as any).dispose?.(true);
  });

  it("replaces an existing writer for the same chat key", async () => {
    const { syncdb: syncdb1 } = makeFakeSyncDB();
    const { syncdb: syncdb2, sets } = makeFakeSyncDB();

    const writer1: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb1 as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    await writer1.waitUntilReady();
    expect(writer1.isClosed()).toBe(false);

    const writer2: any = new ChatStreamWriter({
      metadata: baseMetadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb2 as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    await writer2.waitUntilReady();

    expect(writer1.isClosed()).toBe(true);

    await writer2.handle({
      type: "summary",
      finalResponse: "done",
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer2);

    const final = sets[sets.length - 1];
    expect(final.generating).toBe(false);
    writer1.dispose?.(true);
    writer2.dispose?.(true);
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
    expect(
      (turns.heartbeatAcpTurnLease as any).mock.calls.length,
    ).toBeGreaterThan(0);
    expect(
      (turns.updateAcpTurnLeaseSessionId as any).mock.calls.length,
    ).toBeGreaterThan(0);
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

  it("uses interrupted text when no final summary text exists", async () => {
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
    const final = [...sets]
      .reverse()
      .find((row: any) => row.message_id === baseMetadata.message_id) as any;
    expect(final.generating).toBe(false);
    expect(final.acp_interrupted).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("persists interrupted content immediately when a running turn is interrupted", async () => {
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
      type: "event",
      event: {
        type: "message",
        text: "First paragraph.",
      } as any,
      seq: 0,
    } as AcpStreamMessage);
    await (writer as any).handle({
      type: "event",
      event: {
        type: "message",
        text: "Second paragraph.",
      } as any,
      seq: 1,
    } as AcpStreamMessage);
    (writer as any).notifyInterrupted("Conversation interrupted.");
    await flush(writer);

    const final = sets[sets.length - 1] as any;
    expect(final.generating).toBe(false);
    expect(final.acp_interrupted).toBe(true);
    expect(final.history?.[0]?.content ?? "").toContain("First paragraph.");
    expect(final.history?.[0]?.content ?? "").toContain("Second paragraph.");
    expect(final.history?.[0]?.content ?? "").toContain(
      "Conversation interrupted.",
    );
    (writer as any).dispose?.(true);
  });

  it("keeps streamed output and appends the interrupt notice when no final summary arrives", async () => {
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
      event: {
        type: "message",
        text: "I'm still working through this.",
      } as any,
      seq: 0,
    } as AcpStreamMessage);
    (writer as any).notifyInterrupted("Conversation interrupted.");
    await (writer as any).handle({
      type: "summary",
      finalResponse: "",
      seq: 1,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toContain(
      "I'm still working through this.",
    );
    expect((writer as any).content).toContain("Conversation interrupted.");
    (writer as any).dispose?.(true);
  });

  it("persists interrupted content from normalized streamed message chunks", async () => {
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

    for (const [seq, text] of [
      [0, "I"],
      [1, "'m"],
      [2, " going"],
      [3, " to"],
      [4, " wait"],
      [5, " here."],
    ] as const) {
      await (writer as any).handle({
        type: "event",
        event: {
          type: "message",
          text,
        } as any,
        seq,
      } as AcpStreamMessage);
    }
    (writer as any).notifyInterrupted("Conversation interrupted.");
    await flush(writer);

    const final = sets[sets.length - 1] as any;
    expect(final.generating).toBe(false);
    expect(final.history?.[0]?.content).toBe(
      "I'm going to wait here.\n\nConversation interrupted.",
    );
    (writer as any).dispose?.(true);
  });

  it("keeps the final summary text when interrupt lands during completion", async () => {
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

    expect((writer as any).content).toContain("late final response");
    expect((writer as any).content).toContain("Please fix X");
    const final = [...sets]
      .reverse()
      .find((row: any) => row.message_id === baseMetadata.message_id) as any;
    expect(final.generating).toBe(false);
    expect(final.acp_interrupted).toBe(true);
    (writer as any).dispose?.(true);
  });

  it("uses summary text as authoritative final content", async () => {
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
      finalResponse: "final response",
      seq: 2,
    } as AcpStreamMessage);
    await flush(writer);

    expect((writer as any).content).toBe("final response");
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

  it("persists message and thread ids on chat updates", async () => {
    const { syncdb, sets } = makeFakeSyncDB();
    const writer: any = new ChatStreamWriter({
      metadata: {
        ...baseMetadata,
        message_id: "msg-1",
        thread_id: "thread-1",
        parent_message_id: "user-msg-1",
      } as any,
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
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const final = [...sets]
      .reverse()
      .find(
        (row: any) => row?.message_id === "msg-1" && row?.parent_message_id,
      ) as any;
    expect(final.message_id).toBe("msg-1");
    expect(final.thread_id).toBe("thread-1");
    expect(final.parent_message_id).toBe("user-msg-1");
    expect(final.reply_to_message_id).toBeUndefined();
    expect(final.reply_to).toBeUndefined();
    writer.dispose?.(true);
  });

  it("persists verified inline code links from assistant markdown", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "chat-inline-links-"),
    );
    try {
      const workspaceRoot = path.join(tempRoot, "work");
      await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "src", "exists.ts"), "x\n");
      await fs.mkdir(path.join(tempRoot, "rooms"), { recursive: true });
      await fs.writeFile(path.join(tempRoot, "rooms", "chat.chat"), "");

      const { syncdb, sets } = makeFakeSyncDB();
      const writer: any = new ChatStreamWriter({
        metadata: {
          ...baseMetadata,
          path: "rooms/chat.chat",
          message_id: "msg-inline-links",
        } as any,
        client: makeFakeClient(),
        approverAccountId: "u",
        hostWorkspaceRoot: workspaceRoot,
        syncdbOverride: syncdb as any,
        logStoreFactory: () =>
          ({
            set: async () => {},
          }) as any,
      });

      await (writer as any).handle({
        type: "summary",
        finalResponse:
          "Use `src/exists.ts:12` and ignore `a=7` and `src/missing.ts`.",
        seq: 0,
      } as AcpStreamMessage);
      await flush(writer);

      const final = sets[sets.length - 1] as any;
      const expectedWorkspaceRoot = await fs.realpath(workspaceRoot);
      const expectedExistsPath = await fs.realpath(
        path.join(workspaceRoot, "src", "exists.ts"),
      );
      expect(Array.isArray(final.inline_code_links)).toBe(true);
      expect(final.inline_code_links).toHaveLength(1);
      expect(final.inline_code_links[0]).toMatchObject({
        code: "src/exists.ts:12",
        abs_path: expectedExistsPath,
        display_path_at_turn: "src/exists.ts",
        workspace_root_at_turn: expectedWorkspaceRoot,
        line: 12,
      });
      writer.dispose?.(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps absolute display paths and ignores links outside workspace root", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "chat-inline-links-abs-"),
    );
    try {
      const workspaceRoot = path.join(tempRoot, "work");
      const insidePath = path.join(workspaceRoot, "src", "inside.ts");
      const outsidePath = path.join(tempRoot, "outside.ts");
      await fs.mkdir(path.dirname(insidePath), { recursive: true });
      await fs.writeFile(insidePath, "inside\n");
      await fs.writeFile(outsidePath, "outside\n");
      await fs.mkdir(path.join(tempRoot, "rooms"), { recursive: true });
      await fs.writeFile(path.join(tempRoot, "rooms", "chat.chat"), "");

      const { syncdb, sets } = makeFakeSyncDB();
      const writer: any = new ChatStreamWriter({
        metadata: {
          ...baseMetadata,
          path: "rooms/chat.chat",
          message_id: "msg-inline-links-abs",
        } as any,
        client: makeFakeClient(),
        approverAccountId: "u",
        hostWorkspaceRoot: workspaceRoot,
        syncdbOverride: syncdb as any,
        logStoreFactory: () =>
          ({
            set: async () => {},
          }) as any,
      });

      await (writer as any).handle({
        type: "summary",
        finalResponse: `Use \`${insidePath}:7\` and ignore \`${outsidePath}:1\`.`,
        seq: 0,
      } as AcpStreamMessage);
      await flush(writer);

      const final = sets[sets.length - 1] as any;
      const expectedWorkspaceRoot = await fs.realpath(workspaceRoot);
      const expectedInsidePath = await fs.realpath(insidePath);
      expect(Array.isArray(final.inline_code_links)).toBe(true);
      expect(final.inline_code_links).toHaveLength(1);
      expect(final.inline_code_links[0]).toMatchObject({
        code: `${insidePath}:7`,
        abs_path: expectedInsidePath,
        display_path_at_turn: insidePath.split(path.sep).join("/"),
        workspace_root_at_turn: expectedWorkspaceRoot,
        line: 7,
      });
      writer.dispose?.(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("maps absolute chat paths through the host workspace root", async () => {
    const writer: any = new ChatStreamWriter({
      metadata: {
        ...baseMetadata,
        path: "/root/notes/chat.chat",
        message_id: "msg-host-chat-path",
      } as any,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: makeFakeSyncDB().syncdb as any,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    writer.workspaceRoot = "/root";
    writer.hostWorkspaceRoot = "/mnt/cocalc/project-test";

    expect((writer as any).resolveChatFilePath()).toBe(
      "/mnt/cocalc/project-test/notes/chat.chat",
    );
    writer.dispose?.(true);
  });

  it("resolves chat row by message_id when sender/date changed", async () => {
    const rowDate = new Date("2026-02-21T10:11:12.000Z").toISOString();
    const rows: any[] = [
      {
        event: "chat",
        date: rowDate,
        sender_id: "legacy-codex",
        history: [],
        generating: true,
        message_id: "msg-lookup-1",
      },
    ];
    const sets: any[] = [];
    const syncdb: any = {
      metadata: baseMetadata,
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        sets.push(val);
        const idx = rows.findIndex(
          (row) =>
            row.event === val.event &&
            row.date === val.date &&
            row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    const writer: any = new ChatStreamWriter({
      metadata: {
        ...baseMetadata,
        message_date: new Date("2026-02-21T10:11:13.000Z").toISOString(),
        sender_id: "new-codex-sender",
        message_id: "msg-lookup-1",
      } as any,
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
      seq: 0,
    } as AcpStreamMessage);
    await flush(writer);

    const final = [...sets].reverse().find((x) => x?.event === "chat") as any;
    expect(final.date).toBe(rowDate);
    expect(final.sender_id).toBe("legacy-codex");
    writer.dispose?.(true);
  });

  it("persists session id into thread-config without mutating root rows", async () => {
    const rootIso = new Date(100).toISOString();
    const turnIso = new Date(200).toISOString();
    const metadata = {
      ...baseMetadata,
      message_date: turnIso,
      sender_id: "codex-agent",
      reply_to: rootIso,
      thread_id: "legacy-thread-100",
    } as AcpChatContext;
    const rows: any[] = [
      {
        event: "chat",
        date: rootIso,
        sender_id: "user-1",
        history: [],
        acp_config: { model: "gpt-5.3-codex" },
      },
      {
        event: "chat",
        date: rootIso,
        sender_id: "codex-agent",
        history: [],
        reply_to: rootIso,
      },
      {
        event: "chat-thread-config",
        sender_id: threadConfigSenderId("legacy-thread-100"),
        date: CHAT_THREAD_META_ROW_DATE,
        thread_id: "legacy-thread-100",
        acp_config: { model: "gpt-5.3-codex" },
      },
    ];
    const sets: any[] = [];
    const syncdb: any = {
      metadata,
      isReady: () => true,
      get: () => rows,
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        sets.push(val);
        const idx = rows.findIndex(
          (row) =>
            row.event === val.event &&
            row.date === val.date &&
            row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };

    const writer: any = new ChatStreamWriter({
      metadata,
      client: makeFakeClient(),
      approverAccountId: "u",
      syncdbOverride: syncdb,
      logStoreFactory: () =>
        ({
          set: async () => {},
        }) as any,
    });
    await writer.waitUntilReady();
    await writer.persistSessionId("session-123");
    await delay(0);

    const threadCfgUpdate = sets.find(
      (x) =>
        x.event === "chat-thread-config" &&
        x.sender_id === threadConfigSenderId("legacy-thread-100") &&
        x.date === CHAT_THREAD_META_ROW_DATE,
    );
    expect(
      sets.find(
        (x) => x.event === "chat" && x.date === rootIso && x.acp_config,
      ),
    ).toBeUndefined();
    expect(threadCfgUpdate?.acp_config).toEqual({
      model: "gpt-5.3-codex",
      sessionId: "session-123",
    });
    writer.dispose?.(true);
  });
});

describe("recoverOrphanedAcpTurns", () => {
  it("marks stale generating turn as interrupted with restart notice", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    setCurrent({
      event: "chat",
      date: "123",
      sender_id: "codex-agent",
      message_id: "msg-recover-1",
      thread_id: "thread-recover-1",
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
        message_id: "msg-recover-1",
        thread_id: "thread-recover-1",
      },
    ]);

    const recovered = await recoverOrphanedAcpTurns(makeFakeClient() as any);

    expect(recovered).toBe(1);
    const final = sets.find(
      (row: any) => row.event === "chat" && row.generating === false,
    ) as any;
    const threadState = sets.find(
      (row: any) =>
        row.event === "chat-thread-state" && row.state === "interrupted",
    ) as any;
    expect(final.generating).toBe(false);
    expect(final.sender_id).toBe("codex-agent");
    expect(final.acp_interrupted).toBe(true);
    expect(final.acp_interrupted_reason).toBe("server_restart");
    expect(final.history?.[0]?.content).toContain(
      "Conversation interrupted because the backend server restarted.",
    );
    expect(threadState).toBeTruthy();
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

  it("recovers by message_id when lease sender/date are stale", async () => {
    const rowDate = new Date("2026-02-21T11:00:00.000Z").toISOString();
    const rows: any[] = [
      {
        event: "chat",
        date: rowDate,
        sender_id: "legacy-codex",
        generating: true,
        message_id: "msg-stale-1",
        history: [
          {
            author_id: "codex-agent",
            content: "partial answer",
            date: rowDate,
          },
        ],
      },
    ];
    const sets: any[] = [];
    const syncdb: any = {
      metadata: baseMetadata,
      isReady: () => true,
      get: (where: any) =>
        rows.filter((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where ?? {}).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        sets.push(val);
        const idx = rows.findIndex(
          (row) =>
            row.event === val.event &&
            row.date === val.date &&
            row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "p",
        path: "chat",
        // intentionally stale identity:
        message_date: new Date("2026-02-21T11:00:10.000Z").toISOString(),
        sender_id: "new-codex",
        message_id: "msg-stale-1",
      },
    ]);

    const recovered = await recoverOrphanedAcpTurns(makeFakeClient() as any);
    expect(recovered).toBe(1);
    const final = sets.find(
      (row: any) => row.event === "chat" && row.generating === false,
    ) as any;
    expect(final.date).toBe(rowDate);
    expect(final.sender_id).toBe("legacy-codex");
    expect(final.acp_interrupted).toBe(true);
  });

  it("does not mutate thread-config session metadata during restart recovery", async () => {
    const rootIso = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const turnIso = new Date("2026-01-01T00:01:00.000Z").toISOString();
    const rows: any[] = [
      {
        event: "chat",
        date: turnIso,
        sender_id: "codex-agent",
        generating: true,
        history: [
          {
            author_id: "codex-agent",
            content: "partial output",
            date: turnIso,
          },
        ],
        message_id: "msg-1",
        thread_id: "thread-1",
      },
      {
        event: "chat-thread-config",
        sender_id: threadConfigSenderId("thread-1"),
        date: CHAT_THREAD_META_ROW_DATE,
        thread_id: "thread-1",
        acp_config: {
          model: "gpt-5.3-codex",
          sessionId: "session-keep",
        },
      },
    ];
    const sets: any[] = [];
    const syncdb: any = {
      metadata: baseMetadata,
      isReady: () => true,
      get: () => rows,
      get_one: (where: any) =>
        rows.find((row) =>
          Object.entries(where).every(([k, v]) => row[k] === v),
        ),
      set: (val: any) => {
        sets.push(val);
        const idx = rows.findIndex(
          (row) =>
            row.event === val.event &&
            row.date === val.date &&
            row.sender_id === val.sender_id,
        );
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...val };
        } else {
          rows.push({ ...val });
        }
      },
      commit: jest.fn(),
      save: jest.fn(async () => {}),
      close: async () => {},
    };

    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "p",
        path: "chat",
        message_date: turnIso,
        sender_id: "codex-agent",
        reply_to: rootIso,
        message_id: "msg-1",
        thread_id: "thread-1",
      },
    ]);

    const recovered = await recoverOrphanedAcpTurns(makeFakeClient() as any);

    expect(recovered).toBe(1);
    expect(
      sets.find((row) => row.event === "chat-thread-config"),
    ).toBeUndefined();
    const cfg = rows.find(
      (row) =>
        row.event === "chat-thread-config" &&
        row.sender_id === threadConfigSenderId("thread-1") &&
        row.date === CHAT_THREAD_META_ROW_DATE,
    );
    expect(cfg?.acp_config).toEqual({
      model: "gpt-5.3-codex",
      sessionId: "session-keep",
    });
  });
});

describe("repairInterruptedAcpTurn", () => {
  it("repairs a stale running chat thread with no live backend turn", async () => {
    const { syncdb, setCurrent } = makeFakeSyncDB();
    setCurrent({
      event: "chat",
      date: "2026-03-19T20:00:00.000Z",
      sender_id: "codex-agent",
      message_id: "msg-interrupt-1",
      thread_id: "thread-interrupt-1",
      generating: true,
      history: [
        {
          author_id: "codex-agent",
          content: "partial answer",
          date: "2026-03-19T20:00:00.000Z",
        },
      ],
    });
    syncdb.set({
      event: "chat-thread-state",
      sender_id: "system",
      date: "2026-03-19T20:00:00.001Z",
      thread_id: "thread-interrupt-1",
      state: "running",
      active_message_id: "msg-interrupt-1",
    });
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);

    const repaired = await repairInterruptedAcpTurn({
      client: makeFakeClient() as any,
      turn: {
        project_id: "p",
        path: "chat",
        message_date: "2026-03-19T20:00:00.000Z",
        sender_id: "codex-agent",
        message_id: "msg-interrupt-1",
        thread_id: "thread-interrupt-1",
      },
      interruptedNotice: "Conversation interrupted.",
      interruptedReasonId: "interrupt",
      recoveryReason: "Conversation interrupted.",
    });

    const finalChat = syncdb.get_one({
      event: "chat",
      message_id: "msg-interrupt-1",
    });
    const finalThreadState = syncdb.get_one({
      event: "chat-thread-state",
      thread_id: "thread-interrupt-1",
    });
    expect(repaired).toBe(true);
    expect(finalChat?.generating).toBe(false);
    expect(finalChat?.acp_interrupted).toBe(true);
    expect(finalThreadState?.state).toBe("interrupted");
  });
});

describe("recoverCurrentWorkerStuckAcpTurns", () => {
  it("repairs a running lease owned by the current worker when no live writer remains", async () => {
    const { syncdb, sets, setCurrent } = makeFakeSyncDB();
    (chatServer.acquireChatSyncDB as any).mockResolvedValue(syncdb);
    const metadata = {
      ...baseMetadata,
      message_date: "2026-03-19T20:10:00.000Z",
      sender_id: "codex-agent",
      message_id: "msg-stuck-1",
      thread_id: "thread-stuck-1",
    } as any;
    const writer: any = new ChatStreamWriter({
      metadata,
      client: makeFakeClient() as any,
      approverAccountId: "acct-1",
      syncdbOverride: syncdb,
    });
    await writer.waitUntilReady();
    const ownerInstanceId = (turns.startAcpTurnLease as any).mock.calls[0][0]
      .owner_instance_id;
    writer.dispose?.(true);

    setCurrent({
      event: "chat",
      date: metadata.message_date,
      sender_id: metadata.sender_id,
      message_id: metadata.message_id,
      thread_id: metadata.thread_id,
      generating: true,
      history: [
        {
          author_id: "codex-agent",
          content: "still running",
          date: metadata.message_date,
        },
      ],
    });
    syncdb.set({
      event: "chat-thread-state",
      sender_id: "system",
      date: "2026-03-19T20:10:00.001Z",
      thread_id: metadata.thread_id,
      state: "running",
      active_message_id: metadata.message_id,
    });
    (turns.finalizeAcpTurnLease as any).mockReset();
    (turns.listRunningAcpTurnLeases as any).mockReturnValue([
      {
        project_id: "p",
        path: "chat",
        message_date: metadata.message_date,
        sender_id: metadata.sender_id,
        message_id: metadata.message_id,
        thread_id: metadata.thread_id,
        owner_instance_id: ownerInstanceId,
        heartbeat_at: 0,
        started_at: 0,
      },
    ]);

    const recovered = await recoverCurrentWorkerStuckAcpTurns(
      makeFakeClient() as any,
      { graceMs: 0 },
    );

    expect(recovered).toBe(1);
    expect(
      sets.find(
        (row: any) =>
          row.event === "chat-thread-state" &&
          row.thread_id === metadata.thread_id &&
          row.state === "interrupted",
      ),
    ).toBeTruthy();
    expect((turns.finalizeAcpTurnLease as any).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            state: "aborted",
            reason: "backend lost live Codex turn",
          }),
        ],
      ]),
    );
  });
});
