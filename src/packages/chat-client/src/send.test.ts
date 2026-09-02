/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

import { ChatSendPipeline, type ChatSendTransport } from "./send";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";

function fakeDb(
  events: string[],
  config?: {
    completionOverride?: "inherit" | "on" | "off";
    legacyNotifyOnTurnFinish?: boolean;
  },
) {
  const rows: Record<string, any>[] = [
    {
      event: "chat-thread-config",
      sender_id: "__thread_config__:thread-1",
      date: "1970-01-01T00:00:00.000Z",
      thread_id: "thread-1",
      agent_kind: "acp",
      agent_model: "gpt-5.6-sol",
      acp_config: {
        reasoning: "high",
        ...(config?.legacyNotifyOnTurnFinish == null
          ? {}
          : { notifyOnTurnFinish: config.legacyNotifyOnTurnFinish }),
      },
      ...(config?.completionOverride == null
        ? {}
        : { codex_completion_notification: config.completionOverride }),
    },
    {
      event: "chat",
      sender_id: "openai-codex-agent",
      date: "2026-01-01T00:00:01.000Z",
      message_id: "prior-message",
      thread_id: "thread-1",
      acp_thread_id: "codex-session-1",
      history: [],
    },
  ];
  return {
    rows,
    isReady: () => true,
    get: () => rows,
    set: (row: Record<string, any>) => {
      events.push(`set:${row.acp_state ?? row.event}`);
      const index = rows.findIndex(
        (candidate) =>
          row.message_id && candidate.message_id === row.message_id,
      );
      if (index >= 0) rows[index] = row;
      else rows.push(row);
    },
    delete: jest.fn(),
    commit: () => {
      events.push("commit");
      return true;
    },
    save: async () => {
      events.push("save");
    },
  };
}

function pipeline({
  db,
  transport,
  sleep,
  completionDefault,
}: {
  db: ReturnType<typeof fakeDb>;
  transport: ChatSendTransport;
  sleep?: (ms: number) => Promise<void>;
  completionDefault?: boolean;
}) {
  const ids = ["user-message", "assistant-message"];
  return new ChatSendPipeline({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    path: "agents/mobile.chat",
    db: db as any,
    acpClient: {} as any,
    transport,
    idGenerator: () => ids.shift()!,
    now: () => new Date("2026-01-01T00:00:02.000Z"),
    sleep,
    codexCompletionNotificationDefault: completionDefault,
    ackTimeoutMs: 10,
    ackBackoffMs: 1,
  });
}

describe("ChatSendPipeline", () => {
  it("saves the stable user row before submitting one ACP turn", async () => {
    const events: string[] = [];
    let request: any;
    const transport: ChatSendTransport = {
      stream: async function* (value) {
        events.push("stream");
        request = value;
        yield { seq: 0, type: "status", state: "queued" };
      },
      interrupt: jest.fn(),
      steer: jest.fn(),
    };
    const db = fakeDb(events);
    const client = pipeline({ db, transport });

    const first = client.send({ thread_id: "thread-1", text: "  hello  " });
    const duplicate = client.send({
      thread_id: "thread-1",
      text: "accidental duplicate",
    });
    expect(duplicate).toBe(first);
    await expect(first).resolves.toEqual({
      message_id: "user-message",
      thread_id: "thread-1",
    });

    expect(events.indexOf("save")).toBeLessThan(events.indexOf("stream"));
    expect(request).toEqual(
      expect.objectContaining({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        prompt: "hello",
        session_id: "codex-session-1",
        chat: expect.objectContaining({
          message_id: "assistant-message",
          parent_message_id: "user-message",
          thread_id: "thread-1",
        }),
      }),
    );
    expect(
      db.rows.filter((row) => row.message_id === "user-message"),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "inherits an enabled account default from legacy false",
      config: { legacyNotifyOnTurnFinish: false },
      accountDefault: true,
      expected: true,
    },
    {
      label: "keeps legacy true enabled",
      config: { legacyNotifyOnTurnFinish: true },
      accountDefault: false,
      expected: true,
    },
    {
      label: "honors the dedicated off override",
      config: { completionOverride: "off" as const },
      accountDefault: true,
      expected: false,
    },
  ])("$label", async ({ config, accountDefault, expected }) => {
    const events: string[] = [];
    let request: any;
    const transport: ChatSendTransport = {
      stream: async function* (value) {
        request = value;
        yield { seq: 0, type: "status", state: "queued" };
      },
      interrupt: jest.fn(),
      steer: jest.fn(),
    };
    const db = fakeDb(events, config);

    await pipeline({
      db,
      transport,
      completionDefault: accountDefault,
    }).send({ thread_id: "thread-1", text: "notify me" });

    expect(request.chat.notify_on_turn_finish).toBeUndefined();
    expect(request.chat.completion_notification_enabled).toBe(expected);
  });

  it("interrupts before retrying an ambiguous missing acknowledgement", async () => {
    const events: string[] = [];
    let attempts = 0;
    const transport: ChatSendTransport = {
      stream: async function* () {
        attempts += 1;
        if (attempts === 2) {
          yield {
            seq: 0,
            type: "status",
            state: "running",
          } as AcpStreamMessage;
        }
      },
      interrupt: jest.fn(async () => ({ ok: true, state: "missing" })),
      steer: jest.fn(),
    };
    const db = fakeDb(events);
    const client = pipeline({
      db,
      transport,
      sleep: async () => undefined,
    });

    await client.send({ thread_id: "thread-1", text: "retry safely" });

    expect(attempts).toBe(2);
    expect(transport.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "codex-session-1",
        note: expect.stringContaining("after no ACP acknowledgement"),
      }),
    );
  });

  it("accepts repeated ACP status acknowledgements", async () => {
    const events: string[] = [];
    const db = fakeDb(events);
    let lastState: string | undefined;
    db.commit = () => {
      const state = db.rows.find(
        (row) => row.message_id === "user-message",
      )?.acp_state;
      const changed = state !== lastState;
      lastState = state;
      events.push(`commit:${changed}`);
      return changed;
    };
    const transport: ChatSendTransport = {
      stream: async function* () {
        yield { seq: 0, type: "status", state: "queued" } as AcpStreamMessage;
        yield { seq: 1, type: "status", state: "queued" } as AcpStreamMessage;
      },
      interrupt: jest.fn(),
      steer: jest.fn(),
    };

    await expect(
      pipeline({ db, transport }).send({
        thread_id: "thread-1",
        text: "repeat status",
      }),
    ).resolves.toEqual({
      message_id: "user-message",
      thread_id: "thread-1",
    });
    expect(events).toContain("commit:false");
  });

  it("marks a running assistant row interrupted after backend confirmation", async () => {
    const events: string[] = [];
    const db = fakeDb(events);
    db.rows.push({
      event: "chat",
      sender_id: "openai-codex-agent",
      date: "2026-01-01T00:00:03.000Z",
      message_id: "running-message",
      thread_id: "thread-1",
      generating: true,
      history: [],
    });
    const transport: ChatSendTransport = {
      stream: async function* () {},
      interrupt: jest.fn(async () => ({ ok: true, state: "interrupted" })),
      steer: jest.fn(),
    };
    const client = pipeline({ db, transport });

    await client.interrupt("thread-1");

    expect(db.rows.find((row) => row.message_id === "running-message")).toEqual(
      expect.objectContaining({ generating: false, acp_interrupted: true }),
    );
    expect(db.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "chat-thread-state",
          thread_id: "thread-1",
          state: "interrupted",
        }),
      ]),
    );
  });

  it("persists guidance before steering the active Codex turn", async () => {
    const events: string[] = [];
    const db = fakeDb(events);
    db.rows.push({
      event: "chat",
      sender_id: "openai-codex-agent",
      date: "2026-01-01T00:00:03.000Z",
      message_id: "running-message",
      thread_id: "thread-1",
      generating: true,
      history: [],
    });
    let request: any;
    const transport: ChatSendTransport = {
      stream: async function* () {},
      interrupt: jest.fn(),
      steer: jest.fn(async (value) => {
        events.push("steer");
        request = value;
        return { ok: true, state: "steered" };
      }),
    };

    await expect(
      pipeline({ db, transport }).sendGuidance({
        thread_id: "thread-1",
        text: "focus on the regression",
      }),
    ).resolves.toEqual({
      message_id: "user-message",
      thread_id: "thread-1",
    });

    expect(events.indexOf("save")).toBeLessThan(events.indexOf("steer"));
    expect(request).toEqual(
      expect.objectContaining({
        prompt: "focus on the regression",
        session_id: "codex-session-1",
        chat: expect.objectContaining({
          send_mode: "immediate",
          parent_message_id: "user-message",
        }),
      }),
    );
    expect(db.rows.find((row) => row.message_id === "user-message")).toEqual(
      expect.objectContaining({
        acp_send_mode: "immediate",
        acp_state: "sent",
        parent_message_id: "running-message",
      }),
    );
  });
});
