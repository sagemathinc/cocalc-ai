/** @jest-environment jsdom */

import immutable from "immutable";

describe("ConatClient routed project-host reconnect", () => {
  it("reconnects a cached routed host client after disconnect", () => {
    jest.useFakeTimers();

    const connect = jest.fn();
    const close = jest.fn();
    const connHandlers: Record<string, Function> = {};
    const eventHandlers: Record<string, Function> = {};
    const routedClient = {
      conn: {
        connected: false,
        on: jest.fn((event: string, cb: Function) => {
          connHandlers[event] = cb;
        }),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers[event] = cb;
      }),
      connect,
      close,
      request: jest.fn(),
    };

    jest.resetModules();

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000001": immutable.Map({
                host_id: "host-1",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                connect_url: "http://project-host",
                updated_at: Date.now(),
              }),
            }),
          });
        }),
        getActions: jest.fn(() => ({
          ensure_host_info: jest.fn(),
        })),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn(() => routedClient),
    }));

    jest.doMock("@cocalc/conat/client", () => ({
      getClient: () => ({ on: jest.fn() }),
      setConatClient: jest.fn(),
      getLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        silly: jest.fn(),
      }),
    }));

    jest.doMock("@cocalc/conat/hub/api", () => ({
      initHubApi: () => ({}),
    }));

    jest.doMock("./browser-session", () => ({
      createBrowserSessionAutomation: () => ({
        start: jest.fn(),
        stop: jest.fn(),
      }),
    }));

    jest.doMock("@cocalc/util/async-utils", () => ({
      until: jest.fn(),
    }));

    jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
      appBasePath: "",
    }));

    jest.doMock("@cocalc/frontend/client/client", () => ({
      ACCOUNT_ID_COOKIE: "account_id",
    }));

    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: false,
    }));

    jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
      deleteRememberMe: jest.fn(),
      hasRememberMe: jest.fn(() => false),
      setRememberMe: jest.fn(),
    }));

    const { ConatClient } = require("./client");

    const client = new ConatClient(
      {
        account_id: "acct-1",
        browser_id: "browser-1",
        emit: jest.fn(),
      },
      { address: "http://hub", remote: true },
    ) as any;

    client.getOrCreateRoutedHubClient({
      host_id: "host-1",
      address: "http://project-host",
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    client.projectHostTokens["host-1"] = {
      token: "stale-token",
      expiresAt: Date.now() + 60_000,
    };

    eventHandlers.disconnected?.();

    expect(client.projectHostTokens["host-1"]?.token).toBeUndefined();

    jest.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
