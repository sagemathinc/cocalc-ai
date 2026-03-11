/** @jest-environment jsdom */

import { ChatActions } from "../actions";
import { setChatOverlayOpen } from "../drawer-overlay-state";

function makeActions() {
  const redux = {
    getStore: () => null,
    _set_state: () => undefined,
    removeActions: () => undefined,
  } as any;
  const actions = new ChatActions("chat", redux) as ChatActions & {
    syncdb: any;
    frameId: string;
    frameTreeActions: any;
  };
  actions.syncdb = {};
  actions.frameId = "frame-1";
  actions.frameTreeActions = {
    set_frame_data: jest.fn(),
  } as any;
  return actions;
}

describe("ChatActions scroll guards with overlays", () => {
  const overlayId = "test-overlay-scroll-guard";

  afterEach(() => {
    setChatOverlayOpen(overlayId, false);
    jest.useRealTimers();
  });

  it("suppresses scrollToIndex requests while any overlay is open", () => {
    const actions = makeActions();
    jest.useFakeTimers();
    setChatOverlayOpen(overlayId, true);
    actions.scrollToIndex(12);
    jest.runAllTimers();
    expect(actions.frameTreeActions.set_frame_data).not.toHaveBeenCalled();
  });

  it("suppresses scrollToDate requests while any overlay is open", () => {
    const actions = makeActions();
    jest.useFakeTimers();
    setChatOverlayOpen(overlayId, true);
    actions.scrollToDate(Date.now());
    jest.runAllTimers();
    expect(actions.frameTreeActions.set_frame_data).not.toHaveBeenCalled();
  });

  it("still emits scrollToIndex requests when overlays are closed", () => {
    const actions = makeActions();
    jest.useFakeTimers();
    setChatOverlayOpen(overlayId, false);
    actions.scrollToIndex(7);
    jest.runAllTimers();
    expect(actions.frameTreeActions.set_frame_data).toHaveBeenCalledTimes(2);
  });

  it("can scroll to a date without re-persisting the chat fragment", () => {
    const actions = makeActions();
    const setFragment = jest.spyOn(actions, "setFragment");
    jest.useFakeTimers();

    actions.scrollToDate(1234, { persistFragment: false });
    jest.runAllTimers();

    expect(setFragment).not.toHaveBeenCalled();
    expect(actions.frameTreeActions.set_frame_data).toHaveBeenNthCalledWith(1, {
      id: "frame-1",
      scrollToIndex: null,
      scrollToDate: null,
    });
    expect(actions.frameTreeActions.set_frame_data).toHaveBeenNthCalledWith(2, {
      id: "frame-1",
      scrollToDate: "1234",
      scrollToIndex: null,
    });
  });
});
