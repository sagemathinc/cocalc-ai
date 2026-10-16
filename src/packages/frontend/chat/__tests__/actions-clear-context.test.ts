/** @jest-environment jsdom */

import { Map as iMap } from "immutable";
import { ChatActions } from "../actions";

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: jest.fn(() => new Date("2026-10-06T05:00:00.000Z")),
    mark_file: jest.fn(),
  },
}));

const THREAD = "thread-1";

function makeActions(acpState: iMap<string, string>, messages: any[]): any {
  const actions: any = new (ChatActions as any)("proj-1", "x.chat");
  actions.syncdb = {
    set: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn(),
    get_state: jest.fn(() => "ready"),
    save: jest.fn(),
  };
  actions.store = {
    get: jest.fn((key: string) => (key === "acpState" ? acpState : undefined)),
    setState: jest.fn(),
  };
  actions.normalizeThreadId = (key: string) => key;
  actions.getMessagesInThread = () => messages;
  actions.getThreadMetadata = () => ({ agent_runtime: "claude" });
  actions.setThreadConfigRecord = jest.fn(() => true);
  actions.redux = { getStore: () => ({ get_account_id: () => "account-1" }) };
  return actions;
}

const message = {
  event: "chat",
  date: "2026-10-06T04:59:00.000Z",
  message_id: "message-1",
  thread_id: THREAD,
  history: [],
};

describe("clearAgentContext", () => {
  // The hub fences a turn that started before the clear (it neither saves its
  // session back nor takes guidance), so clearing never waits for one.
  it.each([
    ["idle", iMap({ [`thread:${THREAD}`]: "completed" })],
    ["running a turn", iMap({ [`thread:${THREAD}`]: "running" })],
    ["holding a queued message", iMap({ "message:message-1": "queue" })],
    ["sending a message", iMap({ "message:message-1": "sending" })],
  ])("clears a thread that is %s", (_label, acpState) => {
    const actions = makeActions(acpState as iMap<string, string>, [message]);
    expect(actions.clearAgentContext(THREAD)).toBe(true);
    expect(actions.setThreadConfigRecord).toHaveBeenCalledWith(
      THREAD,
      { agent_session_id: "" },
      { threadId: THREAD },
    );
    // The marker's id is the thread's new context generation.
    expect(actions.syncdb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: THREAD,
        parent_message_id: "message-1",
        acp_context_cleared: true,
      }),
    );
    expect(actions.syncdb.commit).toHaveBeenCalled();
  });
});
