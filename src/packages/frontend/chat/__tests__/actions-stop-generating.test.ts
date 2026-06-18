/** @jest-environment jsdom */

import { Map as iMap } from "immutable";
import {
  ChatActions,
  shouldOptimisticallyStopGeneratingLocally,
} from "../actions";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

const mockInterruptAcp = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: jest.fn(() => new Date("2026-02-21T18:00:00.000Z")),
    mark_file: jest.fn(),
    conat_client: {
      interruptAcp: (...args: any[]) => mockInterruptAcp(...args),
    },
  },
}));

function makeActions(message: any): any {
  const actions: any = new (ChatActions as any)("proj-1", "x.chat");
  actions.syncdb = {
    set: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn(),
    get_state: jest.fn(() => "ready"),
    save: jest.fn(),
    save_to_disk: jest.fn(),
  };
  let acpState = iMap<string, string>()
    .set(`message:${message.message_id}`, "running")
    .set(`thread:${message.thread_id}`, "running");
  actions.store = {
    get: jest.fn((key: string) => {
      if (key === "project_id") return "proj-1";
      if (key === "path") return "x.chat";
      if (key === "acpState") return acpState;
      return undefined;
    }),
    setState: jest.fn((patch) => {
      if (patch.acpState != null) acpState = patch.acpState;
    }),
  };
  actions.messageCache = {
    getByDateKey: jest.fn(() => message),
  };
  return actions;
}

function runningCodexMessage() {
  return {
    event: "chat",
    sender_id: "gpt-5.1",
    date: "2026-02-21T18:00:00.000Z",
    message_id: "message-running",
    thread_id: "thread-running",
    acp_state: "running",
    history: [],
  };
}

describe("shouldOptimisticallyStopGeneratingLocally", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest
      .spyOn(webapp_client as any, "server_time")
      .mockReturnValue(new Date("2026-02-21T18:00:00.000Z"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps Codex turns live until the backend confirms the interrupt", () => {
    expect(
      shouldOptimisticallyStopGeneratingLocally({ threadId: "session-123" }),
    ).toBe(false);
  });

  it("still allows optimistic stop for legacy non-ACP turns", () => {
    expect(shouldOptimisticallyStopGeneratingLocally({})).toBe(true);
    expect(shouldOptimisticallyStopGeneratingLocally()).toBe(true);
  });

  it("durably clears Codex running state after backend interrupt acknowledgement", async () => {
    const message = runningCodexMessage();
    const actions = makeActions(message);
    mockInterruptAcp.mockResolvedValueOnce({
      ok: true,
      state: "interrupted",
    });

    await expect(
      actions.languageModelStopGenerating(new Date(message.date), {
        threadId: message.thread_id,
        senderId: message.sender_id,
      }),
    ).resolves.toBe(true);

    expect(mockInterruptAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        threadId: "thread-running",
      }),
    );
    expect(actions.syncdb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat",
        message_id: "message-running",
        acp_state: null,
        acp_interrupted: true,
      }),
    );
    expect(actions.syncdb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat-thread-state",
        thread_id: "thread-running",
        active_message_id: "message-running",
        state: "interrupted",
      }),
    );
  });

  it("clears stale Codex state when backend confirms no session exists", async () => {
    const message = runningCodexMessage();
    const actions = makeActions(message);
    mockInterruptAcp.mockResolvedValueOnce({
      ok: true,
      state: "missing",
    });

    await expect(
      actions.languageModelStopGenerating(new Date(message.date), {
        threadId: message.thread_id,
        senderId: message.sender_id,
      }),
    ).resolves.toBe(true);

    expect(actions.syncdb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat",
        message_id: "message-running",
        acp_state: null,
        acp_interrupted: true,
        acp_interrupted_text: expect.stringContaining(
          "confirmed that no running session exists",
        ),
      }),
    );
    expect(actions.store.setState).toHaveBeenCalledWith({
      acpState: expect.anything(),
    });
  });

  it("does not clear Codex running state on interrupt transport failure", async () => {
    const message = runningCodexMessage();
    const actions = makeActions(message);
    mockInterruptAcp.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      actions.languageModelStopGenerating(new Date(message.date), {
        threadId: message.thread_id,
        senderId: message.sender_id,
      }),
    ).resolves.toBe(false);

    expect(actions.syncdb.set).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat",
        message_id: "message-running",
        acp_interrupted: true,
      }),
    );
    expect(actions.store.setState).not.toHaveBeenCalled();
  });
});
