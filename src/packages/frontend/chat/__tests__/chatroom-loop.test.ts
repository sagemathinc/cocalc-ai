/** @jest-environment jsdom */

import { clearThreadLoopRuntime, enabledLoopConfig } from "../chatroom";

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
});
