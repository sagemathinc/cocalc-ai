/** @jest-environment jsdom */

import immutable from "immutable";
import { EventEmitter } from "events";

describe("ConatClient routed project-host reconnect", () => {
  it("reuses one routed host client for same-host project subjects", async () => {
    jest.resetModules();

    const connectCalls: any[] = [];
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(),
    };
    const routedClient1 = {
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      request: jest.fn(),
    };
    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            open_projects: immutable.List([
              "00000000-0000-4000-8000-000000000001",
              "00000000-0000-4000-8000-000000000002",
            ]),
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000001": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
              }),
              "00000000-0000-4000-8000-000000000002": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                bay_id: "bay-1",
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
      connect: jest.fn((opts?: any) => {
        connectCalls.push(opts);
        if (opts?.address === "http://hub") {
          return hubClient;
        }
        return routedClient1;
      }),
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    const defaultClient = client.conat();
    const routeSubject = connectCalls[0]?.routeSubject;

    expect(defaultClient).toBe(hubClient);
    expect(typeof routeSubject).toBe("function");

    const routed1 = routeSubject(
      "project.00000000-0000-4000-8000-000000000001.api",
    );
    const routed2 = routeSubject(
      "project.00000000-0000-4000-8000-000000000002.api",
    );

    expect(routed1?.client).toBe(routedClient1);
    expect(routed2?.client).toBe(routedClient1);
    expect(connectCalls).toHaveLength(2);
    expect(
      Array.from(client.routedHubClients["host-1"].project_ids).sort(),
    ).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("sends project touches directly to the routed project-host client", async () => {
    jest.resetModules();

    const connectCalls: any[] = [];
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(async (_subject: string, mesg: any) => ({
        data: {
          token: `token-for-${mesg.args?.[0]?.project_id ?? "host"}`,
          expires_at: Date.now() + 5 * 60_000,
        },
      })),
    };
    const routedClient = {
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      request: jest.fn(async () => ({ data: null })),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            open_projects: immutable.List([
              "00000000-0000-4000-8000-000000000001",
            ]),
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000001": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                bay_id: "bay-1",
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
      connect: jest.fn((opts?: any) => {
        connectCalls.push(opts);
        if (opts?.address === "http://hub") {
          return hubClient;
        }
        return routedClient;
      }),
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    await client.touchProjectHost({
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    expect(routedClient.request).toHaveBeenCalledWith(
      "project.00000000-0000-4000-8000-000000000001.touch.-",
      ["touch", []],
      { timeout: 15000, waitForInterest: true },
    );
  });

  it("reissues shared host auth using a remaining tracked project and frees the host client when none remain", async () => {
    jest.resetModules();

    const connectCalls: any[] = [];
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(async (_subject: string, mesg: any) => ({
        data: {
          token: `token-for-${mesg.args?.[0]?.project_id ?? "host"}`,
          expires_at: Date.now() + 5 * 60_000,
        },
      })),
    };
    const routedClient = {
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      request: jest.fn(),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            open_projects: immutable.List([
              "00000000-0000-4000-8000-000000000001",
              "00000000-0000-4000-8000-000000000002",
            ]),
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000001": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
              }),
              "00000000-0000-4000-8000-000000000002": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                bay_id: "bay-1",
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
      connect: jest.fn((opts?: any) => {
        connectCalls.push(opts);
        if (opts?.address === "http://hub") {
          return hubClient;
        }
        return routedClient;
      }),
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    const defaultClient = client.conat();
    const routeSubject = connectCalls[0]?.routeSubject;
    expect(defaultClient).toBe(hubClient);
    expect(typeof routeSubject).toBe("function");

    routeSubject("project.00000000-0000-4000-8000-000000000001.api");
    routeSubject("project.00000000-0000-4000-8000-000000000002.api");

    client.releaseProjectHostRouting({
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    const routedAuth = connectCalls[1]?.auth;
    expect(typeof routedAuth).toBe("function");
    await new Promise<void>((resolve) => {
      routedAuth(() => resolve());
    });

    expect(hubClient.request).toHaveBeenLastCalledWith(
      "hub.account.acct-1.api",
      {
        name: "hosts.issueProjectHostAuthToken",
        args: [
          {
            host_id: "host-1",
            project_id: "00000000-0000-4000-8000-000000000002",
          },
        ],
      },
      { timeout: 15000 },
    );

    client.releaseProjectHostRouting({
      project_id: "00000000-0000-4000-8000-000000000002",
    });
    expect(routedClient.close).toHaveBeenCalledTimes(1);
    expect(client.routedHubClients["host-1"]).toBeUndefined();
  });

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
                owning_bay_id: "bay-1",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                bay_id: "bay-1",
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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
        bay_id: "bay-1",
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
              bay_id: "bay-1",
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
                owning_bay_id: "bay-1",
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

  it("rebuilds the routed host client after repeated same-session reconnect failures", async () => {
    jest.useFakeTimers();

    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
          connect: jest.fn(),
          disconnect: jest.fn(),
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
    };

    const connect1 = jest.fn();
    const close1 = jest.fn();
    const eventHandlers1: Record<string, Function> = {};
    const routedClient1 = {
      conn: {
        connected: false,
        on: jest.fn(),
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
    const routedClient2 = {
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: connect2,
      close: close2,
      request: jest.fn(),
    };

    let hostInfo = immutable.Map({
      "host-1": immutable.Map({
        bay_id: "bay-1",
        connect_url: "http://project-host",
        host_session_id: "session-1",
        updated_at: Date.now(),
      }),
    });
    const ensureHostInfo = jest.fn(async () => hostInfo.get("host-1"));

    jest.resetModules();

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000001": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-1",
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    eventHandlers1.disconnected?.();
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();

    eventHandlers1.disconnected?.();
    jest.advanceTimersByTime(3_500);
    await Promise.resolve();
    await Promise.resolve();

    eventHandlers1.disconnected?.();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(connect1).toHaveBeenCalledTimes(2);
    expect(close1).toHaveBeenCalledTimes(1);
    expect(connect2).toHaveBeenCalledTimes(1);
    expect(client.routedHubClients["host-1"].client).toBe(routedClient2);
    expect(client.routedHubClients["host-1"].host_session_id).toBe("session-1");

    jest.useRealTimers();
  });

  it("forces a host-info refresh when the cached host bay mismatches the project bay", async () => {
    let hostInfo = immutable.Map({
      "host-1": immutable.Map({
        bay_id: "bay-1",
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
              bay_id: "bay-2",
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
                owning_bay_id: "bay-2",
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

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn(() => ({
        conn: {
          connected: false,
          on: jest.fn(),
          io: {
            on: jest.fn(),
            engine: {
              close: jest.fn(),
            },
          },
        },
        on: jest.fn(),
        connect: jest.fn(),
        close: jest.fn(),
        request: jest.fn(),
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    const routing = await client.ensureProjectRoutingInfo(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(routing).toMatchObject({
      host_id: "host-1",
      address: "http://project-host",
      host_session_id: "session-2",
    });
  });

  it("falls back to the hub for codex device auth in lite mode when host routing is unavailable", async () => {
    const ensureHostInfo = jest.fn(async () => undefined);
    const hubRequest = jest.fn(async () => ({
      data: { id: "auth-1", state: "pending" },
    }));

    jest.resetModules();

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            project_map: immutable.Map({
              "00000000-1000-4000-8000-000000000000": immutable.Map({}),
            }),
            host_info: immutable.Map({}),
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

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn(() => ({
        inboxPrefixHook: undefined,
        info: undefined,
        conn: {
          connected: false,
          on: jest.fn(),
          io: {
            on: jest.fn(),
            engine: {
              close: jest.fn(),
            },
          },
        },
        on: jest.fn(),
        connect: jest.fn(),
        close: jest.fn(),
        disconnect: jest.fn(),
        request: hubRequest,
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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
      lite: true,
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

    const result = await client.callHub({
      name: "projects.codexDeviceAuthStart",
      args: [{ project_id: "00000000-1000-4000-8000-000000000000" }],
      project_id: "00000000-1000-4000-8000-000000000000",
    });

    expect(result).toEqual({ id: "auth-1", state: "pending" });
    expect(ensureHostInfo).not.toHaveBeenCalled();
    expect(hubRequest).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      {
        name: "projects.codexDeviceAuthStart",
        args: [{ project_id: "00000000-1000-4000-8000-000000000000" }],
      },
      expect.any(Object),
    );
  });
});

describe("ConatClient home-bay bootstrap", () => {
  it("waits for auth bootstrap before creating the default control-plane client", async () => {
    jest.resetModules();

    const connectCalls: any[] = [];
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: false,
        on: jest.fn(),
        io: {
          on: jest.fn(),
          engine: {
            close: jest.fn(),
          },
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(),
      emit: jest.fn(),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(),
        getActions: jest.fn(),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn((opts?: any) => {
        connectCalls.push(opts);
        return hubClient;
      }),
    }));

    jest.doMock("@cocalc/conat/client", () => ({
      getClient: () => ({ on: jest.fn() }),
      setConatClient: jest.fn(),
    }));

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    jest.doMock("js-cookie", () => ({
      __esModule: true,
      default: {
        get: jest.fn((name: string) =>
          name === "account_id" ? "acct-remote" : undefined,
        ),
        set: jest.fn(),
      },
    }));

    const setStoredControlPlaneOrigin = jest.fn();
    jest.doMock("@cocalc/frontend/control-plane-origin", () => ({
      clearStoredControlPlaneOrigin: jest.fn(),
      getControlPlaneAppUrl: jest.fn(() => undefined),
      getStoredControlPlaneOrigin: jest.fn(() => undefined),
      normalizeControlPlaneOrigin: jest.fn((value: string) =>
        value?.replace(/\/+$/, ""),
      ),
      setStoredControlPlaneOrigin,
    }));

    const getAuthBootstrap = jest.fn(async () => ({
      signed_in: false,
      home_bay_id: "bay-2",
      home_bay_url: "https://bay-2-lite4b.cocalc.ai",
    }));
    jest.doMock("@cocalc/frontend/auth/api", () => ({
      getAuthBootstrap,
    }));

    const { ConatClient } = require("./client");
    new ConatClient(
      {
        account_id: "acct-remote",
        browser_id: "browser-1",
        emit: jest.fn(),
      },
      { address: "https://lite4b.cocalc.ai", remote: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAuthBootstrap).toHaveBeenCalledTimes(1);
    expect(setStoredControlPlaneOrigin).toHaveBeenCalledWith(
      "https://bay-2-lite4b.cocalc.ai",
    );
    expect(connectCalls[0]?.address).toBe("https://bay-2-lite4b.cocalc.ai");
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

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

describe("ConatClient main reconnect scheduling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses a single scheduled reconnect path", async () => {
    jest.resetModules();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    class MockCoreClient extends EventEmitter {
      info: any;
      stats = {};
      conn: any;
      connect = jest.fn();
      close = jest.fn();
      disconnect = jest.fn();

      constructor() {
        super();
        this.conn = new EventEmitter();
        this.conn.connected = false;
        this.conn.connect = this.connect;
        this.conn.on = this.conn.addListener.bind(this.conn);
        this.conn.io = {
          on: jest.fn(),
          engine: { close: jest.fn() },
        };
      }
    }

    const hubClient = new MockCoreClient();

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
      connect: jest.fn(() => hubClient),
    }));

    jest.doMock("@cocalc/conat/client", () => ({
      getClient: () => ({ on: jest.fn() }),
      setConatClient: jest.fn(),
    }));

    jest.doMock("@cocalc/conat/time", () => ({
      __esModule: true,
      default: jest.fn(() => Date.now()),
      getSkew: jest.fn(async () => 0),
      init: jest.fn(),
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

    client.conat();
    hubClient.emit("connected");
    hubClient.emit("disconnected", "transport close", {});
    client.resume();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(hubClient.connect).toHaveBeenCalledTimes(1);
  });
});
