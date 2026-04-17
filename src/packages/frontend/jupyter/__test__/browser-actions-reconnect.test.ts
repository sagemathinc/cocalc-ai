/** @jest-environment jsdom */

const registerReconnectResource = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      registerReconnectResource,
    },
  },
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

describe("JupyterActions reconnect coordination", () => {
  beforeEach(() => {
    registerReconnectResource.mockReset();
    registerReconnectResource.mockReturnValue({
      requestReconnect: jest.fn(),
      close: jest.fn(),
    });
  });

  it("registers a reconnect resource that waits for live syncdb recovery", async () => {
    const wait_until_live_connected = jest.fn(async () => {});
    const wait_until_ready = jest.fn(async () => {});
    const target: any = {
      isClosed: jest.fn(() => false),
      syncdb: {
        is_live_connected: () => false,
        wait_until_live_connected,
        get_state: () => "ready",
      },
      wait_until_ready,
      isSyncdbLiveConnected: JupyterActions.prototype["isSyncdbLiveConnected"],
    };

    JupyterActions.prototype["initReconnectResource"].call(target);

    expect(registerReconnectResource).toHaveBeenCalledTimes(1);
    const options = registerReconnectResource.mock.calls[0][0];
    expect(options.canReconnect()).toBe(true);
    expect(options.isConnected()).toBe(false);
    await options.reconnect();
    expect(wait_until_live_connected).toHaveBeenCalled();
    expect(wait_until_ready).toHaveBeenCalled();
  });
});
