/** @jest-environment jsdom */

jest.mock("awaiting", () => ({ delay: jest.fn(async () => undefined) }));

import { Actions } from "../actions";

describe("chat notification fragment navigation", () => {
  it("selects the thread, opens its attention request, and scrolls", async () => {
    const chatActions = {
      setSelectedThread: jest.fn(),
      openCodexAttention: jest.fn(),
      scrollToDate: jest.fn(),
    };
    const actions: any = Object.create(Actions.prototype);
    actions.waitUntilFrameReady = jest.fn().mockResolvedValue("frame-1");
    actions.getChatActions = jest.fn(() => chatActions);
    actions.set_frame_data = jest.fn();

    await actions.gotoFragment({
      chat: "1234",
      thread: "thread-1",
      attention: "attention-1",
    });

    expect(chatActions.setSelectedThread).toHaveBeenCalledWith("thread-1");
    expect(actions.set_frame_data).toHaveBeenCalledWith({
      id: "frame-1",
      fragmentId: "1234",
    });
    expect(chatActions.openCodexAttention).toHaveBeenCalledTimes(1);
    expect(chatActions.openCodexAttention).toHaveBeenCalledWith(
      "1234",
      "attention-1",
    );
    expect(chatActions.scrollToDate).toHaveBeenCalledWith("1234", {
      persistFragment: false,
    });
    expect(
      chatActions.setSelectedThread.mock.invocationCallOrder[0],
    ).toBeLessThan(chatActions.openCodexAttention.mock.invocationCallOrder[0]);
  });

  it("publishes a message-only URL target for thread selection", async () => {
    const actions: any = Object.create(Actions.prototype);
    actions.waitUntilFrameReady = jest.fn().mockResolvedValue("frame-1");
    actions.set_frame_data = jest.fn();
    const chatActions = { scrollToDate: jest.fn() };
    actions.getChatActions = jest.fn(() => chatActions);
    await actions.gotoFragment({ chat: "1788832135399" });
    expect(actions.set_frame_data).toHaveBeenCalledWith({
      id: "frame-1",
      fragmentId: "1788832135399",
    });
    expect(chatActions.scrollToDate).toHaveBeenCalledWith("1788832135399", {
      persistFragment: false,
    });
  });
});
