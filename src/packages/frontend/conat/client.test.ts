/** @jest-environment jsdom */

import immutable from "immutable";
import { EventEmitter } from "events";

let historyPushStateSpy: jest.SpyInstance;
let historyReplaceStateSpy: jest.SpyInstance;
const originalFetch = global.fetch;

beforeEach(() => {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
  historyPushStateSpy = jest
    .spyOn(window.history, "pushState")
    .mockImplementation(() => undefined);
  historyReplaceStateSpy = jest
    .spyOn(window.history, "replaceState")
    .mockImplementation(() => undefined);
  Object.defineProperty(global, "fetch", {
    configurable: true,
    value: jest.fn(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    })),
  });
});

afterEach(() => {
  historyPushStateSpy.mockRestore();
  historyReplaceStateSpy.mockRestore();
  if (originalFetch) {
    Object.defineProperty(global, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  } else {
    delete (global as any).fetch;
  }
});

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
        connected: true,
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
      request: jest.fn(async () => ({ data: { ok: true } })),
      stats: {
        send: { messages: 4, bytes: 40 },
        recv: { messages: 5, bytes: 50 },
        subs: 1,
      },
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

    const targets = client.getConnectionTargets();
    expect(targets.map((target) => target.id)).toEqual([
      "hub",
      "project-host:host-1",
    ]);
    expect(targets[1].status.stats).toEqual(routedClient1.stats);

    await expect(
      client.probeConnectionTarget("project-host:host-1", 1000),
    ).resolves.toEqual(expect.any(Number));
    expect(routedClient1.request).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      { name: "system.ping", args: [] },
      { timeout: 1000 },
    );
  });

  it("routes filesystem subjects directly to the project-host even when the project bay differs from the host bay", async () => {
    jest.resetModules();

    const connectCalls: any[] = [];
    const ensureHostInfo = jest.fn(async () => undefined);
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
    const routedClient = {
      conn: {
        connected: true,
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
      request: jest.fn(async () => ({ data: { ok: true } })),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            open_projects: immutable.List([
              "00000000-0000-4000-8000-000000000003",
            ]),
            project_map: immutable.Map({
              "00000000-0000-4000-8000-000000000003": immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-2",
              }),
            }),
            host_info: immutable.Map({
              "host-1": immutable.Map({
                bay_id: "bay-0",
                connect_url: "http://project-host",
                host_session_id: "session-1",
                updated_at: Date.now(),
              }),
            }),
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

    client.conat();
    const routeSubject = connectCalls[0]?.routeSubject;

    const routed = routeSubject(
      "fs.project-00000000-0000-4000-8000-000000000003",
    );

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(routed?.client).toBe(routedClient);
    expect(connectCalls).toHaveLength(2);
    expect(client.routedHubClients["host-1"]?.client).toBe(routedClient);
  });

  it("warms project-host routing before projectApi requests", async () => {
    jest.resetModules();

    const project_id = "00000000-0000-4000-8000-000000000004";
    const connectCalls: any[] = [];
    const routedFsClient = { kind: "fs-client" };
    const routedListingsClient = { kind: "listings-client" };
    const listingsClient = jest.fn(async () => routedListingsClient);
    let hostInfo: any;
    const ensureHostInfo = jest.fn(async () => {
      hostInfo = immutable.Map({
        bay_id: "bay-0",
        connect_url: "http://project-host",
        host_session_id: "session-1",
        updated_at: Date.now(),
      });
    });
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
      request: jest.fn(async () => ({ data: { error: "hub fallback" } })),
    };
    const routedClient = {
      conn: {
        connected: true,
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
      request: jest.fn(async () => ({ data: 123 })),
      fs: jest.fn(() => routedFsClient),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn((name: string) => {
          if (name !== "projects") return undefined;
          return immutable.Map({
            open_projects: immutable.List([project_id]),
            project_map: immutable.Map({
              [project_id]: immutable.Map({
                host_id: "host-1",
                owning_bay_id: "bay-0",
              }),
            }),
            host_info: immutable.Map(hostInfo ? { "host-1": hostInfo } : {}),
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

    jest.doMock("@cocalc/conat/service/listings", () => ({
      listingsClient,
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

    await expect(
      client.projectApi({ project_id }).system.version(),
    ).resolves.toBe(123);

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", false);
    expect(hubClient.request).not.toHaveBeenCalled();
    expect(routedClient.request).toHaveBeenCalledWith(
      `project.${project_id}.api.-`,
      { name: "system.version", args: [] },
      { timeout: 15000, waitForInterest: true },
    );
    expect(connectCalls.map((opts) => opts?.address)).toContain(
      "http://project-host",
    );

    await expect(
      client.projectFs({ project_id, caller: "test.projectFs" }),
    ).resolves.toBe(routedFsClient);
    expect(routedClient.fs).toHaveBeenCalledWith({ project_id });

    await expect(client.listings({ project_id })).resolves.toBe(
      routedListingsClient,
    );
    expect(listingsClient).toHaveBeenCalledWith({
      project_id,
      client: routedClient,
    });
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
    client.invalidateProjectHostToken("host-1", { resetFailureState: true });
    client.invalidateProjectHostBrowserSession("host-1");
    hubClient.request.mockClear();

    await client.ensureProjectHostBrowserSession({
      host_id: "host-1",
      address: "http://project-host",
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
      { timeout: 4000 },
    );

    client.releaseProjectHostRouting({
      project_id: "00000000-0000-4000-8000-000000000002",
    });
    expect(routedClient.close).toHaveBeenCalledTimes(1);
    expect(client.routedHubClients["host-1"]).toBeUndefined();
  });

  it("reconnects a cached routed host client after disconnect", async () => {
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
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "token-1",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };
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
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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
    await jest.advanceTimersByTimeAsync(200);
    connect.mockClear();
    hubClient.request.mockClear();
    (global.fetch as jest.Mock).mockClear();

    client.projectHostTokens["host-1"] = {
      token: "stale-token",
      expiresAt: Date.now() + 60_000,
    };

    eventHandlers.disconnected?.();

    expect(client.projectHostTokens["host-1"]?.token).toBe("stale-token");

    await jest.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(hubClient.request).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("drops a cached routed host token only after an auth-related connect_error", async () => {
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
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "fresh-token",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };

    const connect = jest.fn();
    const eventHandlers: Record<string, Function> = {};
    const connectErrorHandlers: Function[] = [];
    const routedClient = {
      conn: {
        connected: false,
        on: jest.fn((event: string, cb: Function) => {
          if (event === "connect_error") {
            connectErrorHandlers.push(cb);
          }
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
      close: jest.fn(),
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
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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
    await jest.advanceTimersByTimeAsync(200);
    connect.mockClear();
    hubClient.request.mockClear();

    client.projectHostTokens["host-1"] = {
      token: "cached-token",
      expiresAt: Date.now() + 60_000,
    };

    expect(connectErrorHandlers).toHaveLength(1);
    connectErrorHandlers[0](new Error("missing project-host bearer token"));

    expect(client.projectHostTokens["host-1"]?.token).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(hubClient.request).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      expect.objectContaining({
        name: "hosts.issueProjectHostAuthToken",
      }),
      expect.objectContaining({ timeout: 4000 }),
    );
    expect(connect).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it("re-bootstraps the shared browser session after a routed sign-in auth failure", async () => {
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
        },
      },
      on: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "fresh-token",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };

    const connect = jest.fn();
    const eventHandlers: Record<string, Function> = {};
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
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers[event] = cb;
      }),
      connect,
      close: jest.fn(),
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
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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
    await jest.advanceTimersByTimeAsync(200);
    connect.mockClear();
    hubClient.request.mockClear();
    (global.fetch as jest.Mock).mockClear();

    client.projectHostTokens["host-1"] = {
      token: "cached-token",
      expiresAt: Date.now() + 60_000,
    };
    client.projectHostBrowserSessions["host-1"] = {
      address: "http://project-host",
      establishedAt: Date.now(),
    };

    eventHandlers.info?.({
      user: {
        error: "failed to sign in - Error: missing project-host bearer token",
      },
    });

    expect(client.projectHostTokens["host-1"]?.token).toBeUndefined();
    expect(
      client.projectHostBrowserSessions["host-1"]?.address,
    ).toBeUndefined();
    expect(
      client.projectHostBrowserSessions["host-1"]?.establishedAt,
    ).toBeUndefined();

    eventHandlers.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(hubClient.request).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      expect.objectContaining({
        name: "hosts.issueProjectHostAuthToken",
      }),
      expect.objectContaining({ timeout: 4000 }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://project-host/.cocalc/project-host/session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    expect(connect).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it("retries routed host reconnect after a host-info refresh failure once the browser is back online", async () => {
    jest.useFakeTimers();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });

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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "token-1",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };

    const connect = jest.fn();
    const close = jest.fn();
    const eventHandlers: Record<string, Function> = {};
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
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers[event] = cb;
      }),
      connect,
      close,
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
    let refreshAttempts = 0;
    const ensureHostInfo = jest.fn(async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) {
        throw Error("temporary routing refresh failure");
      }
      return hostInfo.get("host-1");
    });

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

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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
    await jest.advanceTimersByTimeAsync(200);
    connect.mockClear();

    eventHandlers.disconnected?.();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(ensureHostInfo).toHaveBeenCalledTimes(0);

    client.automaticallyReconnect = false;
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(200);

    expect(ensureHostInfo).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3_500);

    expect(ensureHostInfo).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(0);

    jest.useRealTimers();
  });

  it("falls back to direct host resolution when cached host-info refresh hangs", async () => {
    jest.useFakeTimers();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    const hubRequest = jest.fn(async (_subject: string, mesg: any) => {
      if (mesg?.name === "hosts.issueProjectHostAuthToken") {
        return {
          data: {
            token: "token-1",
            expires_at: Date.now() + 5 * 60_000,
          },
        };
      }
      return {
        data: {
          host_id: "host-1",
          connect_url: "http://project-host",
          host_session_id: "session-1",
        },
      };
    });
    const hubClient = {
      inboxPrefixHook: undefined,
      info: undefined,
      conn: {
        connected: true,
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
    };

    const connect = jest.fn();
    const eventHandlers: Record<string, Function> = {};
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
      on: jest.fn((event: string, cb: Function) => {
        eventHandlers[event] = cb;
      }),
      connect,
      close: jest.fn(),
      request: jest.fn(),
    };

    const ensureHostInfo = jest.fn(
      () => new Promise<undefined>(() => undefined),
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
          ensure_host_info: ensureHostInfo,
        })),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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
    await jest.advanceTimersByTimeAsync(200);
    connect.mockClear();

    eventHandlers.disconnected?.();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(5_000);

    expect(ensureHostInfo).toHaveBeenCalledTimes(1);
    expect(hubRequest).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      {
        name: "hosts.resolveHostConnection",
        args: [{ host_id: "host-1" }],
      },
      expect.objectContaining({ timeout: 5_000 }),
    );
    expect(connect).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it("forces a reconnect on browser online when routed host sessions are visible but unfocused", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    const hasFocusSpy = jest.spyOn(document, "hasFocus").mockReturnValue(false);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "token-1",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };

    const routedClient = {
      conn: {
        connected: true,
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
      connect: jest.fn((opts?: any) =>
        opts?.address === "http://project-host" ? routedClient : hubClient,
      ),
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

    client.getOrCreateRoutedHubClient({
      host_id: "host-1",
      address: "http://project-host",
      host_session_id: "session-1",
      project_id: "00000000-0000-4000-8000-000000000001",
    });
    client.automaticallyReconnect = true;
    const reconnectSpy = jest
      .spyOn(client, "reconnect")
      .mockImplementation(() => undefined);

    window.dispatchEvent(new Event("online"));

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    reconnectSpy.mockRestore();
    hasFocusSpy.mockRestore();
  });

  it("waits for a fresh project-host auth token before connecting the routed host", async () => {
    jest.useFakeTimers();

    const connectCalls: any[] = [];
    let tokenRequestCount = 0;
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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          tokenRequestCount += 1;
          if (tokenRequestCount === 1) {
            const err: any = new Error("timeout");
            err.code = "408";
            throw err;
          }
          return {
            data: {
              token: "token-2",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
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

    client.getOrCreateRoutedHubClient({
      host_id: "host-1",
      address: "http://project-host",
      host_session_id: "session-1",
      project_id: "00000000-0000-4000-8000-000000000001",
    });

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(routedClient.connect).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(routedClient.connect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3_600);
    expect(routedClient.connect).toHaveBeenCalledTimes(1);
    expect(client.projectHostTokens["host-1"]?.token).toBe("token-2");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://project-host/.cocalc/project-host/session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: {
          Authorization: "Bearer token-2",
        },
      }),
    );

    warn.mockRestore();
    jest.useRealTimers();
  });

  it("single-flights project-host auth token requests per host", async () => {
    let resolveDeferred: ((value: any) => void) | undefined;
    const deferred = new Promise((resolve) => {
      resolveDeferred = resolve;
    });

    jest.resetModules();

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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return await deferred;
        }
        return { data: null };
      }),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(),
        getActions: jest.fn(() => ({})),
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

    const p1 = client.getProjectHostToken({
      host_id: "host-1",
      project_id: "00000000-0000-4000-8000-000000000001",
    });
    const p2 = client.getProjectHostToken({
      host_id: "host-1",
      project_id: "00000000-0000-4000-8000-000000000002",
    });

    expect(hubClient.request).toHaveBeenCalledTimes(1);

    resolveDeferred?.({
      data: {
        token: "token-1",
        expires_at: Date.now() + 5 * 60_000,
      },
    });

    await expect(p1).resolves.toBe("token-1");
    await expect(p2).resolves.toBe("token-1");
    expect(hubClient.request).toHaveBeenCalledTimes(1);
  });

  it("adds a one-shot project-host bearer query param for HTTP app opens", async () => {
    jest.resetModules();

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(() => immutable.Map()),
        getActions: jest.fn(() => ({})),
      },
    }));

    jest.doMock("@cocalc/util/reuse-in-flight", () => ({
      reuseInFlight: (fn: any) => fn,
    }));

    jest.doMock("@cocalc/conat/core/client", () => ({
      connect: jest.fn(() => ({
        conn: { connected: false, on: jest.fn(), io: { on: jest.fn() } },
        on: jest.fn(),
        connect: jest.fn(),
        close: jest.fn(),
        disconnect: jest.fn(),
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

    jest
      .spyOn(client, "ensureProjectRoutingInfo")
      .mockResolvedValue({ host_id: "host-1", address: "http://project-host" });
    jest
      .spyOn(client, "ensureProjectHostBrowserSession")
      .mockResolvedValue(undefined);
    jest.spyOn(client, "getProjectHostToken").mockResolvedValue("token-1");

    const authed = await client.addProjectHostAuthToUrl({
      project_id: "00000000-0000-4000-8000-000000000001",
      url: "/00000000-0000-4000-8000-000000000001/apps/python-hello/?a=1",
    });

    expect(authed).toBe(
      "http://project-host/00000000-0000-4000-8000-000000000001/apps/python-hello/?a=1&cocalc_project_host_token=token-1",
    );
  });

  it("backs off repeated project-host auth token retries per host after a timeout", async () => {
    jest.useFakeTimers();
    jest.resetModules();

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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          const count = hubClient.request.mock.calls.filter(
            ([, data]) => data?.name === "hosts.issueProjectHostAuthToken",
          ).length;
          if (count === 1) {
            const err: any = new Error("timeout");
            err.code = "408";
            throw err;
          }
          return {
            data: {
              token: "token-2",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
    };

    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: jest.fn(),
        getActions: jest.fn(() => ({})),
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

    await expect(
      client.getProjectHostToken({
        host_id: "host-1",
        project_id: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("timeout");
    expect(hubClient.request).toHaveBeenCalledTimes(1);

    await expect(
      client.getProjectHostToken({
        host_id: "host-1",
        project_id: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("cooldown active");
    await expect(
      client.getProjectHostToken({
        host_id: "host-1",
        project_id: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow("cooldown active");
    expect(hubClient.request).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3_000);

    await expect(
      client.getProjectHostToken({
        host_id: "host-1",
        project_id: "00000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toBe("token-2");
    expect(hubClient.request).toHaveBeenCalledTimes(2);

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
    await jest.advanceTimersByTimeAsync(200);
    connect1.mockClear();
    connect2.mockClear();

    eventHandlers1.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(close1).toHaveBeenCalledTimes(1);
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
      request: jest.fn(async (_subject: string, mesg: any) => {
        if (mesg?.name === "hosts.issueProjectHostAuthToken") {
          return {
            data: {
              token: "token-1",
              expires_at: Date.now() + 5 * 60_000,
            },
          };
        }
        return { data: null };
      }),
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
    await jest.advanceTimersByTimeAsync(200);
    connect1.mockClear();
    connect2.mockClear();

    eventHandlers1.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);

    eventHandlers1.disconnected?.();
    await jest.advanceTimersByTimeAsync(3_500);

    eventHandlers1.disconnected?.();
    await jest.advanceTimersByTimeAsync(10_000);

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

  it("does not fall back to the hub for chat-store APIs in launchpad mode when host routing is unavailable", async () => {
    const ensureHostInfo = jest.fn(async () => undefined);
    const hubRequest = jest.fn(async () => ({
      data: { rotated: true, chat_id: "chat-1" },
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

    await expect(
      client.callHub({
        name: "projects.chatStoreRotate",
        args: [
          {
            project_id: "00000000-1000-4000-8000-000000000000",
            chat_path: "/home/user/cocalc-ai/lite4.chat",
          },
        ],
        project_id: "00000000-1000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(
      "unable to route 'projects.chatStoreRotate' to project-host",
    );
    expect(hubRequest).not.toHaveBeenCalled();
  });

  it("falls back to the hub for chat-store APIs in lite mode when host routing is unavailable", async () => {
    const ensureHostInfo = jest.fn(async () => undefined);
    const hubRequest = jest.fn(async () => ({
      data: { rotated: true, chat_id: "chat-1" },
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
      name: "projects.chatStoreRotate",
      args: [
        {
          project_id: "00000000-1000-4000-8000-000000000000",
          chat_path: "/home/user/cocalc-ai/lite4.chat",
        },
      ],
      project_id: "00000000-1000-4000-8000-000000000000",
    });

    expect(result).toEqual({ rotated: true, chat_id: "chat-1" });
    expect(hubRequest).toHaveBeenCalledWith(
      "hub.account.acct-1.api",
      {
        name: "projects.chatStoreRotate",
        args: [
          {
            project_id: "00000000-1000-4000-8000-000000000000",
            chat_path: "/home/user/cocalc-ai/lite4.chat",
          },
        ],
      },
      expect.any(Object),
    );
  });

  it("forces reconnect after a visible hub RPC timeout while transport still looks connected", async () => {
    const timeoutError = Object.assign(
      new Error("operation has timed out subject:hub.account.acct-1.api"),
      { code: 408 },
    );
    const hubRequest = jest
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);

    jest.resetModules();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

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
        inboxPrefixHook: undefined,
        info: undefined,
        conn: {
          connected: true,
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

    await expect(
      client.callHub({
        name: "system.listNews",
        args: [],
      }),
    ).rejects.toThrow("callHub");
    await Promise.resolve();
    await Promise.resolve();

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(hubRequest).toHaveBeenCalledTimes(2);
    reconnectSpy.mockRestore();
  });

  it("does not force reconnect from a failed stale probe when recent hub traffic succeeded", async () => {
    const timeoutError = Object.assign(
      new Error("operation has timed out subject:hub.account.acct-1.api"),
      { code: 408 },
    );
    const hubRequest = jest
      .fn()
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);

    jest.resetModules();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

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
        inboxPrefixHook: undefined,
        info: undefined,
        conn: {
          connected: true,
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

    await expect(
      client.callHub({
        name: "system.listNews",
        args: [],
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      client.callHub({
        name: "projects.getProjectActiveOperation",
        args: ["00000000-1000-4000-8000-000000000000"],
      }),
    ).rejects.toThrow("callHub");
    await Promise.resolve();
    await Promise.resolve();

    expect(reconnectSpy).toHaveBeenCalledTimes(0);
    expect(hubRequest).toHaveBeenCalledTimes(3);
    reconnectSpy.mockRestore();
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
    const hasFocusSpy = jest.spyOn(document, "hasFocus").mockReturnValue(true);
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);

    try {
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
    } finally {
      hasFocusSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it("forces a reconnect after a long hidden interval when the wake probe fails", async () => {
    jest.resetModules();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    const hasFocusSpy = jest.spyOn(document, "hasFocus").mockReturnValue(true);
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);

    try {
      class MockCoreClient extends EventEmitter {
        info: any;
        stats = {};
        conn: any;
        connect = jest.fn();
        close = jest.fn();
        request = jest.fn(async () => {
          throw Error("wake probe failed");
        });

        constructor() {
          super();
          this.conn = new EventEmitter();
          this.conn.connected = true;
          this.conn.connect = this.connect;
          this.conn.on = this.conn.addListener.bind(this.conn);
          this.conn.io = {
            on: jest.fn(),
            engine: { close: jest.fn() },
          };
          this.disconnect = jest.fn(() => {
            this.conn.connected = false;
          });
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
        initHubApi: () => ({
          system: { ping: jest.fn() },
        }),
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

      jest.doMock("@cocalc/frontend/auth/api", () => ({
        getAuthBootstrap: jest.fn(async () => ({
          signed_in: true,
          account_id: "acct-1",
          home_bay_id: "hub-0",
          home_bay_url: "http://hub",
        })),
      }));

      const { ConatClient } = require("./client");
      const client = new ConatClient(
        {
          account_id: "acct-1",
          browser_id: "browser-1",
          emit: jest.fn(),
        },
        { address: "http://hub", remote: false },
      ) as any;

      client.conat();
      hubClient.info = {
        id: "hub-0",
        user: { account_id: "acct-1" },
      };
      hubClient.emit("info", hubClient.info);
      hubClient.emit("connected");

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      hasFocusSpy.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));

      await jest.advanceTimersByTimeAsync(61_000);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      hasFocusSpy.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));

      await Promise.resolve();
      await Promise.resolve();
      expect(hubClient.disconnect).toHaveBeenCalledTimes(1);
      expect(hubClient.conn.io.engine.close).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(hubClient.connect).toHaveBeenCalledTimes(1);
    } finally {
      hasFocusSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});
