/** @jest-environment jsdom */

import immutable from "immutable";

describe("ConatClient routed project-host reconnect", () => {
  it("reconnects a cached routed host client after disconnect", async () => {
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
                host_session_id: "session-1",
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

    jest.doMock("@cocalc/util/async-utils", () => {
      const actual = jest.requireActual("@cocalc/util/async-utils");
      return {
        ...actual,
        until: jest.fn(),
      };
    });

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
      host_session_id: "session-1",
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    client.projectHostTokens["host-1"] = {
      token: "stale-token",
      expiresAt: Date.now() + 60_000,
    };

    eventHandlers.disconnected?.();

    expect(client.projectHostTokens["host-1"]?.token).toBeUndefined();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it("rebuilds the routed host client after a host session change", async () => {
    jest.useFakeTimers();

    const hubConnHandlers: Record<string, Function> = {};
    const hubEventHandlers: Record<string, Function> = {};
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn((event: string, cb: Function) => {
          hubConnHandlers[event] = cb;
        }),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
          connect: jest.fn(),
          disconnect: jest.fn(),
        },
      },
      on: jest.fn((event: string, cb: Function) => {
        hubEventHandlers[event] = cb;
      }),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
    };

    const connect1 = jest.fn();
    const close1 = jest.fn();
    const connHandlers1: Record<string, Function> = {};
    const eventHandlers1: Record<string, Function> = {};
    const routedClient1 = {
      conn: {
        connected: false,
        on: jest.fn((event: string, cb: Function) => {
          connHandlers1[event] = cb;
        }),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers1[event] = cb;
      }),
      connect: connect1,
      close: close1,
      request: jest.fn(),
    };

    const connect2 = jest.fn();
    const close2 = jest.fn();
    const connHandlers2: Record<string, Function> = {};
    const eventHandlers2: Record<string, Function> = {};
    const routedClient2 = {
      conn: {
        connected: false,
        on: jest.fn((event: string, cb: Function) => {
          connHandlers2[event] = cb;
        }),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers2[event] = cb;
      }),
      connect: connect2,
      close: close2,
      request: jest.fn(),
    };

    let hostInfo = immutable.Map({
      "host-1": immutable.Map({
        connect_url: "http://project-host",
        host_session_id: "session-1",
        updated_at: Date.now(),
      }),
    });
    const ensureHostInfo = jest.fn(
      async (_host_id: string, force?: boolean) => {
        if (force) {
          hostInfo = hostInfo.set(
            "host-1",
            immutable.Map({
              connect_url: "http://project-host",
              host_session_id: "session-2",
              updated_at: Date.now(),
            }),
          );
        }
        return hostInfo.get("host-1");
      },
    );

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
            host_info: hostInfo,
          });
        }),
        getActions: jest.fn(() => ({
          ensure_host_info: ensureHostInfo,
        })),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    let routedCreates = 0;
    const connectToConat = jest.fn((opts?: any) => {
      if (opts?.address === "http://hub") {
        return hubClient;
      }
      routedCreates += 1;
      return routedCreates === 1 ? routedClient1 : routedClient2;
    });
    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: connectToConat,
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

    jest.doMock("@cocalc/util/async-utils", () => {
      const actual = jest.requireActual("@cocalc/util/async-utils");
      return {
        ...actual,
        until: jest.fn(),
      };
    });

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
    const reconnectSpy = jest
      .spyOn(client, "reconnect")
      .mockImplementation(() => undefined);

    client.getOrCreateRoutedHubClient({
      host_id: "host-1",
      address: "http://project-host",
      host_session_id: "session-1",
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    eventHandlers1.disconnected?.();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(close1).toHaveBeenCalledTimes(1);
    expect(connect2).toHaveBeenCalledTimes(1);
    expect(client.routedHubClients["host-1"].host_session_id).toBe("session-2");
    jest.advanceTimersByTime(50);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});

describe("ConatClient sync wrapper client preservation", () => {
  it("preserves explicit clients for dkv, akv, and dko wrappers", async () => {
    jest.resetModules();

    const dkvMock = jest.fn(async (opts) => opts);
    const akvMock = jest.fn((opts) => opts);
    const dkoMock = jest.fn(async (opts) => opts);

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(() => undefined),
        getActions: jest.fn(() => undefined),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn(() => ({
        conn: {
          connected: false,
          on: jest.fn(),
          io: { on: jest.fn(), engine: { close: jest.fn() } },
        },
        on: jest.fn(),
      })),
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

    jest.doMock("@cocalc/conat/sync/dkv", () => ({
      dkv: dkvMock,
    }));
    jest.doMock("@cocalc/conat/sync/akv", () => ({
      akv: akvMock,
    }));
    jest.doMock("@cocalc/conat/sync/dko", () => ({
      dko: dkoMock,
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

    const explicitClient = { id: "explicit-client" };

    await client.dkv({
      name: "a",
      account_id: "acct-1",
      client: explicitClient,
    });
    client.akv({ name: "b", account_id: "acct-1", client: explicitClient });
    await client.dko({
      name: "c",
      account_id: "acct-1",
      client: explicitClient,
    });

    expect(dkvMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: explicitClient }),
    );
    expect(akvMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: explicitClient }),
    );
    expect(dkoMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: explicitClient }),
    );
  });
});
