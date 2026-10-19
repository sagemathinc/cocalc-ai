/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ChatActions } from "@cocalc/frontend/chat/actions";
import { Actions } from "./actions";

// The agents workspace embeds one chat editor for every agent in a file.
// The route picks the agent; the chat must never pick it back.
describe("chat editor thread selection for an embedding page", () => {
  const editor = () => {
    const selected: string[] = [];
    const chatActions = {
      setSelectedThread: (thread: string) => selected.push(thread),
      scrollToDate: () => {},
    };
    const target: any = {
      navigationGeneration: 0,
      waitUntilFrameReady: async () => "frame-1",
      set_frame_data: () => {},
      getChatActions: () => chatActions,
    };
    for (const name of [
      "gotoFragment",
      "setEmbeddedThreadSelectHandler",
      "userSelectedThread",
    ])
      target[name] = (Actions.prototype as any)[name].bind(target);
    return { target, selected };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("a superseded navigation stops re-applying its thread", async () => {
    const { target, selected } = editor();
    const toA = target.gotoFragment({ thread: "thread-A" });
    await jest.advanceTimersByTimeAsync(20);
    expect(selected).toContain("thread-A");
    const toB = target.gotoFragment({ thread: "thread-B" });
    const before = selected.length;
    await jest.advanceTimersByTimeAsync(5000);
    await Promise.all([toA, toB]);
    // After B was requested, A is never written again: no late echo.
    expect(selected.slice(before)).not.toContain("thread-A");
    expect(selected.at(-1)).toBe("thread-B");
  });

  it("reports the person's choice and cancels a navigation in flight", async () => {
    const { target, selected } = editor();
    const handler = jest.fn();
    target.setEmbeddedThreadSelectHandler(handler);
    const toA = target.gotoFragment({ thread: "thread-A" });
    await jest.advanceTimersByTimeAsync(20);
    target.userSelectedThread("thread-X");
    const before = selected.length;
    await jest.advanceTimersByTimeAsync(5000);
    await toA;
    expect(handler).toHaveBeenCalledWith("thread-X");
    expect(selected.slice(before)).not.toContain("thread-A");
  });

  it("navigation by code is never reported to the embedder", async () => {
    const { target } = editor();
    const handler = jest.fn();
    target.setEmbeddedThreadSelectHandler(handler);
    const toA = target.gotoFragment({ thread: "thread-A" });
    await jest.advanceTimersByTimeAsync(5000);
    await toA;
    expect(handler).not.toHaveBeenCalled();
  });

  it("unregistering keeps a handler that another view registered since", () => {
    const { target } = editor();
    const first = jest.fn();
    const second = jest.fn();
    const unregisterFirst = target.setEmbeddedThreadSelectHandler(first);
    target.setEmbeddedThreadSelectHandler(second);
    unregisterFirst();
    target.userSelectedThread("thread-X");
    expect(second).toHaveBeenCalledWith("thread-X");
    expect(first).not.toHaveBeenCalled();
  });

  it("only selectThreadByUser tells the frame editor", () => {
    const userSelectedThread = jest.fn();
    const set_frame_data = jest.fn();
    const chat: any = {
      frameId: "frame-1",
      frameTreeActions: { userSelectedThread, set_frame_data },
    };
    chat.setSelectedThread = (thread: string) =>
      set_frame_data({ id: "frame-1", selectedThreadKey: thread });
    ChatActions.prototype.selectThreadByUser.call(chat, "thread-X");
    expect(set_frame_data).toHaveBeenCalledWith({
      id: "frame-1",
      selectedThreadKey: "thread-X",
    });
    expect(userSelectedThread).toHaveBeenCalledWith("thread-X");
  });
});
