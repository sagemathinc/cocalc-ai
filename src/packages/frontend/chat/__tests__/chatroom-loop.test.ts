/** @jest-environment jsdom */

import {
  clearThreadLoopRuntime,
  enabledLoopConfig,
  getLatestCodexActivityDate,
} from "../chatroom";

describe("chatroom loop helpers", () => {
  it("returns enabled configs and hides disabled ones", () => {
    expect(enabledLoopConfig(undefined)).toBeUndefined();
    expect(enabledLoopConfig({ enabled: false })).toBeUndefined();
    expect(enabledLoopConfig({ enabled: true, max_turns: 12 })).toEqual({
      enabled: true,
      max_turns: 12,
    });
  });

  it("clears persisted loop config and state for a thread", () => {
    const actions = {
      setThreadLoopConfig: jest.fn(),
      setThreadLoopState: jest.fn(),
    };
    clearThreadLoopRuntime(actions as any, "thread-1");
    expect(actions.setThreadLoopConfig).toHaveBeenCalledWith("thread-1", null);
    expect(actions.setThreadLoopState).toHaveBeenCalledWith("thread-1", null);
  });

  it("ignores empty thread keys", () => {
    const actions = {
      setThreadLoopConfig: jest.fn(),
      setThreadLoopState: jest.fn(),
    };
    clearThreadLoopRuntime(actions as any, " ");
    expect(actions.setThreadLoopConfig).not.toHaveBeenCalled();
    expect(actions.setThreadLoopState).not.toHaveBeenCalled();
  });

  it("returns the newest ACP-backed message date in a thread", () => {
    expect(
      getLatestCodexActivityDate([
        {
          date: "2026-03-20T01:00:00.000Z",
          history: [],
          sender_id: "acct",
          event: "chat",
          acp_account_id: "acct",
        } as any,
        {
          date: "2026-03-20T01:05:00.000Z",
          history: [],
          sender_id: "acct",
          event: "chat",
        } as any,
        {
          date: "2026-03-20T01:10:00.000Z",
          history: [],
          sender_id: "acct",
          event: "chat",
          acp_account_id: "acct",
        } as any,
      ]),
    ).toBe(`${Date.parse("2026-03-20T01:10:00.000Z")}`);
  });

  it("ignores non-ACP and invalid-date rows when resolving latest activity", () => {
    expect(
      getLatestCodexActivityDate([
        {
          date: "not-a-date",
          history: [],
          sender_id: "acct",
          event: "chat",
          acp_account_id: "acct",
        } as any,
        {
          date: "2026-03-20T01:05:00.000Z",
          history: [],
          sender_id: "acct",
          event: "chat",
        } as any,
      ]),
    ).toBeUndefined();
  });
});
