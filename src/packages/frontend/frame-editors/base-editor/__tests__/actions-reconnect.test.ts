import { BaseEditorActions } from "../actions-base";
import type { AppRedux } from "@cocalc/util/redux/types";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      registerReconnectResource: jest.fn(() => ({
        requestReconnect: jest.fn(),
        close: jest.fn(),
      })),
    },
  },
}));

describe("BaseEditorActions reconnect coordination", () => {
  function makeRedux(): AppRedux {
    return {
      getStore: jest.fn(() => ({})),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
    } as unknown as AppRedux;
  }

  it("requests reconnect when a visible editor becomes visible but is not live", async () => {
    const requestReconnect = jest.fn();
    const target: any = {
      setState: jest.fn(),
      areSyncdocsLiveConnected: jest.fn(() => false),
      reconnectResource: { requestReconnect },
      isClosed: jest.fn(() => false),
      set_resize: jest.fn(),
      refresh_visible: jest.fn(),
      focus: jest.fn(),
    };

    await BaseEditorActions.prototype.show.call(target);

    expect(requestReconnect).toHaveBeenCalledWith({
      reason: "editor_became_visible",
      resetBackoff: true,
    });
    expect(target.setState).toHaveBeenCalledWith({
      visible: true,
      rtc_status: "loading",
    });
  });

  it("refreshes editor sync status when a visible editor is already live", async () => {
    const requestReconnect = jest.fn();
    const target: any = {
      setState: jest.fn(),
      areSyncdocsLiveConnected: jest.fn(() => true),
      reconnectResource: { requestReconnect },
      isClosed: jest.fn(() => false),
      set_resize: jest.fn(),
      refresh_visible: jest.fn(),
      focus: jest.fn(),
    };

    await BaseEditorActions.prototype.show.call(target);

    expect(target.setState).toHaveBeenCalledWith({
      visible: true,
      rtc_status: "live",
    });
    expect(requestReconnect).not.toHaveBeenCalled();
  });

  it("removes the syncstring disconnected-listener before manual close", async () => {
    const disconnectedHandler = jest.fn();
    const removeListener = jest.fn();
    const close = jest.fn();
    const target: any = {
      _syncstring: {
        get_state: () => "closed",
        removeListener,
        close,
      },
      handleSyncstringClosed: jest.fn(),
      handleSyncdocDisconnected: disconnectedHandler,
    };

    await BaseEditorActions.prototype["close_syncstring"].call(target);

    expect(removeListener).toHaveBeenCalledWith(
      "disconnected",
      disconnectedHandler,
    );
    expect(removeListener).toHaveBeenCalledWith(
      "closed",
      target.handleSyncstringClosed,
    );
    expect(close).toHaveBeenCalled();
  });

  it("marks structured syncdocs as reconnecting when their live stream disconnects", () => {
    const actions = new BaseEditorActions("test-syncdb", makeRedux()) as any;
    const requestReconnect = jest.fn();
    actions.doctype = "syncdb";
    actions.reconnectResource = { requestReconnect };

    actions.handleSyncdocDisconnected();

    expect(actions.redux._set_state).toHaveBeenCalledWith(
      { "test-syncdb": { rtc_status: "loading" } },
      "test-syncdb",
    );
    expect(requestReconnect).toHaveBeenCalledWith({
      reason: "editor_syncdoc_disconnected",
    });
  });

  it("marks structured syncdocs live when all registered syncdocs reconnect", () => {
    const actions = new BaseEditorActions(
      "test-syncdb-live",
      makeRedux(),
    ) as any;
    actions.doctype = "syncdb";
    actions.areSyncdocsLiveConnected = jest.fn(() => true);

    actions.handleSyncdocConnected();

    expect(actions.redux._set_state).toHaveBeenCalledWith(
      { "test-syncdb-live": { rtc_status: "live" } },
      "test-syncdb-live",
    );
  });

  it("actively recovers a syncdoc before waiting for it to become live", async () => {
    const actions = new BaseEditorActions(
      "test-syncdoc-recover-now",
      makeRedux(),
    ) as any;
    let liveConnected = false;
    const syncdoc = {
      get_state: () => "ready",
      is_live_connected: () => liveConnected,
      recoverNow: jest.fn(async () => {
        liveConnected = true;
      }),
      wait_until_live_connected: jest.fn(async () => {}),
    };
    actions.wait_until_syncdoc_ready = jest.fn(async () => true);
    actions.isClosed = jest.fn(() => false);

    const connected = await actions.wait_until_syncdoc_live_connected(
      syncdoc,
      "foreground",
    );

    expect(connected).toBe(true);
    expect(syncdoc.recoverNow).toHaveBeenCalledWith({
      priority: "foreground",
      reason: "editor_resource_reconnect",
    });
    expect(syncdoc.wait_until_live_connected).toHaveBeenCalled();
  });
});
