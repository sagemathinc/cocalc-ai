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
  // A finished turn can keep its raw row state; only the derived state counts.
  acp_state: "sent",
  history: [],
};

describe("clearAgentContext", () => {
  it.each([
    ["a running thread", iMap({ [`thread:${THREAD}`]: "running" })],
    ["a queued message", iMap({ "message:message-1": "queue" })],
    [
      "a message keyed by date",
      iMap({ [`${new Date(message.date).valueOf()}`]: "sending" }),
    ],
  ])("refuses while the thread has %s", (_label, acpState) => {
    const actions = makeActions(acpState as iMap<string, string>, [message]);
    expect(actions.hasActiveAgentTurn(THREAD)).toBe(true);
    expect(actions.clearAgentContext(THREAD)).toBe(false);
    expect(actions.setThreadConfigRecord).not.toHaveBeenCalled();
    expect(actions.syncdb.set).not.toHaveBeenCalled();
  });

  it("clears an idle thread", () => {
    const actions = makeActions(
      iMap({ [`thread:${THREAD}`]: "completed", "message:message-1": "done" }),
      [message],
    );
    expect(actions.hasActiveAgentTurn(THREAD)).toBe(false);
    expect(actions.clearAgentContext(THREAD)).toBe(true);
    expect(actions.setThreadConfigRecord).toHaveBeenCalledWith(
      THREAD,
      { agent_session_id: "" },
      { threadId: THREAD },
    );
  });
});
