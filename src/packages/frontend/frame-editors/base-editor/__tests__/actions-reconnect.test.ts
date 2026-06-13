import { BaseEditorActions } from "../actions-base";
import type { AppRedux } from "@cocalc/util/redux/types";
import { EventEmitter } from "events";

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

  it("waits for any non-ready syncdoc state before proceeding", async () => {
    const syncdoc = new EventEmitter() as any;
    syncdoc.is_fake = false;
    syncdoc.get_state = jest.fn(() => "loading");
    const target: any = {
      isClosed: jest.fn(() => false),
    };

    const promise = BaseEditorActions.prototype.wait_until_syncdoc_ready.call(
      target,
      syncdoc,
    );
    await Promise.resolve();
    expect(syncdoc.get_state).toHaveBeenCalled();

    syncdoc.get_state = jest.fn(() => "ready");
    syncdoc.emit("ready");

    await expect(promise).resolves.toBe(true);
  });

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

  it("marks loaded structured syncdocs as reconnecting when their live stream disconnects", () => {
    const actions = new BaseEditorActions("test-syncdb", makeRedux()) as any;
    const requestReconnect = jest.fn();
    actions.doctype = "syncdb";
    actions.reconnectResource = { requestReconnect };
    actions.store = { get: jest.fn((key) => key === "is_loaded") };

    actions.handleSyncdocDisconnected();

    expect(actions.redux._set_state).toHaveBeenCalledWith(
      { "test-syncdb": { rtc_status: "reconnecting" } },
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
      force: true,
      priority: "foreground",
      reason: "editor_resource_reconnect",
    });
    expect(syncdoc.wait_until_live_connected).toHaveBeenCalled();
  });

  it("forces recovery even when a syncdoc still reports live", async () => {
    const actions = new BaseEditorActions(
      "test-syncdoc-force-recover",
      makeRedux(),
    ) as any;
    const syncdoc = {
      get_state: () => "ready",
      is_live_connected: () => true,
      recoverNow: jest.fn(async () => {}),
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
      force: true,
      priority: "foreground",
      reason: "editor_resource_reconnect",
    });
  });

  it("tries forced recovery before waiting on an initializing syncdoc", async () => {
    const actions = new BaseEditorActions(
      "test-syncdoc-init-recover",
      makeRedux(),
    ) as any;
    const syncdoc = {
      get_state: () => "init",
      is_live_connected: () => false,
      recoverNow: jest.fn(async () => {}),
    };
    actions.wait_until_syncdoc_ready = jest.fn(async () => false);
    actions.isClosed = jest.fn(() => false);

    const connected = await actions.wait_until_syncdoc_live_connected(
      syncdoc,
      "foreground",
    );

    expect(connected).toBe(false);
    expect(syncdoc.recoverNow).toHaveBeenCalledWith({
      force: true,
      priority: "foreground",
      reason: "editor_resource_reconnect",
    });
    expect(actions.wait_until_syncdoc_ready).toHaveBeenCalledWith(syncdoc);
  });

  it("closes the editor action when a syncstring closes unexpectedly", () => {
    const redux = makeRedux();
    const actions = new BaseEditorActions("test-recover", redux) as any;
    actions.path = "/home/user/a.chat";
    actions.syncAdapter = { dispose: jest.fn() };
    actions.isClosed = jest.fn(() => false);
    actions.close = jest.fn();

    actions.handleSyncstringClosed();

    expect(actions.syncAdapter.dispose).toHaveBeenCalled();
    expect(redux._set_state).not.toHaveBeenCalled();
    expect(actions.close).toHaveBeenCalled();
  });

  it("falls back to closing when no runtime recovery hook is available", () => {
    const actions = new BaseEditorActions("test-close", makeRedux()) as any;
    actions.path = "/home/user/a.chat";
    actions.syncAdapter = { dispose: jest.fn() };
    actions.isClosed = jest.fn(() => false);
    actions._get_project_actions = () => undefined;
    actions.close = jest.fn();

    actions.handleSyncstringClosed();

    expect(actions.close).toHaveBeenCalled();
  });
});
