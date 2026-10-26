/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A project host that accepts a request and never answers must not leave the
// browser stuck "connecting" until a reload: every wait in the routed-host
// connect path is bounded and the reconnect loop keeps going.

import immutable from "immutable";

jest.mock("@cocalc/frontend/customize/exam-mode", () => ({
  isExamMode: () => false,
  waitForExamModeConfiguration: async () => false,
}));

const originalFetch = global.fetch;
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

// fetch that never answers, but (like a browser) rejects when aborted
const hangingFetch = jest.fn(
  (_url: string, opts?: { signal?: AbortSignal }) =>
    new Promise((_, reject) => {
      opts?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    }),
);
const okFetch = jest.fn(async () => ({
  ok: true,
  status: 204,
  text: async () => "",
}));

let recordUxLatencyEvent: jest.Mock;

function setup() {
  const hubClient = {
    inboxPrefixHook: undefined,
    info: undefined,
    conn: {
      connected: false,
      on: jest.fn(),
      io: { on: jest.fn(), engine: { close: jest.fn() } },
    },
    on: jest.fn(),
    connect: jest.fn(),
    close: jest.fn(),
    disconnect: jest.fn(),
    request: jest.fn(async (_subject: string, mesg: any) => {
      if (mesg?.name === "hosts.issueProjectHostAuthToken") {
        return {
          data: { token: "token-1", expires_at: Date.now() + 5 * 60_000 },
        };
      }
      return { data: null };
    }),
  };
  const eventHandlers: Record<string, Function> = {};
  const connHandlers: Record<string, Function> = {};
  const connect = jest.fn();
  const routedClient = {
    conn: {
      connected: false,
      on: jest.fn((event: string, cb: Function) => {
        connHandlers[event] = cb;
      }),
      io: { on: jest.fn(), engine: { close: jest.fn() } },
    },
    on: jest.fn((event: string, cb: Function) => {
      eventHandlers[event] = cb;
    }),
    connect,
    close: jest.fn(),
    request: jest.fn(),
  };

  jest.resetModules();
  recordUxLatencyEvent = jest.fn();
  jest.doMock("@cocalc/frontend/monitoring/ux-latency", () => ({
    recordUxLatencyEvent: (...args: any[]) => recordUxLatencyEvent(...args),
    startUxTimer: () => 0,
    elapsedUxMs: () => 0,
  }));
  jest.doMock("@cocalc/frontend/app-framework", () => ({
    redux: {
      getStore: jest.fn((name: string) => {
        if (name !== "projects") return undefined;
        return immutable.Map({
          project_map: immutable.Map({
            [PROJECT_ID]: immutable.Map({
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
      getActions: jest.fn(() => ({ ensure_host_info: jest.fn() })),
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
  jest.doMock("@cocalc/conat/hub/api", () => ({ initHubApi: () => ({}) }));
  jest.doMock("./browser-session", () => ({
    createBrowserSessionAutomation: () => ({
      start: jest.fn(),
      stop: jest.fn(),
    }),
  }));
  jest.doMock("@cocalc/util/async-utils", () => ({
    ...jest.requireActual("@cocalc/util/async-utils"),
    until: jest.fn(),
  }));
  jest.doMock("@cocalc/frontend/customize/app-base-path", () => ({
    appBasePath: "",
  }));
  jest.doMock("@cocalc/frontend/client/client", () => ({
    ACCOUNT_ID_COOKIE: "account_id",
  }));
  jest.doMock("@cocalc/frontend/lite", () => ({ lite: false }));
  jest.doMock("@cocalc/frontend/misc/remember-me", () => ({
    deleteRememberMe: jest.fn(),
    hasRememberMe: jest.fn(() => false),
    setRememberMe: jest.fn(),
  }));

  const { ConatClient } = require("./client");
  const client = new ConatClient(
    { account_id: "acct-1", browser_id: "browser-1", emit: jest.fn() },
    { address: "http://hub", remote: true },
  ) as any;
  const addHost = () =>
    client.getOrCreateRoutedHubClient({
      host_id: "host-1",
      address: "http://project-host",
      host_session_id: "session-1",
      project_id: PROJECT_ID,
    });
  return {
    client,
    connect,
    eventHandlers,
    connHandlers,
    routedClient,
    addHost,
  };
}

function setFetch(fn: jest.Mock) {
  Object.defineProperty(global, "fetch", { configurable: true, value: fn });
}

let historySpies: jest.SpyInstance[] = [];

beforeEach(() => {
  historySpies = [
    jest.spyOn(window.history, "pushState").mockImplementation(() => undefined),
    jest
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => undefined),
  ];
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
  jest.useFakeTimers();
  hangingFetch.mockClear();
  okFetch.mockClear();
});

afterEach(() => {
  for (const spy of historySpies) spy.mockRestore();
  jest.useRealTimers();
  if (originalFetch) {
    setFetch(originalFetch as any);
  } else {
    delete (global as any).fetch;
  }
});

describe("routed project-host connection liveness", () => {
  it("recovers when the browser-session bootstrap never answers", async () => {
    setFetch(hangingFetch);
    const { client, connect, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();

    const disconnected = jest.fn();
    client.on("project-host-disconnected", disconnected);

    // The bootstrap is aborted after its timeout, and a retry is scheduled.
    await jest.advanceTimersByTimeAsync(15_000);
    // The UI is told, so it shows the host as unavailable instead of nothing.
    expect(disconnected).toHaveBeenCalledWith("host-1");
    const state = client.routedHubClients["host-1"];
    expect(`${state.lastConnectError}`).toMatch(/timed out/);
    // ... and a new attempt (a new bootstrap request) has started.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(hangingFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Once the host answers again, the next retry connects without a reload.
    setFetch(okFetch);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(okFetch).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });

  it("drops a connect attempt that never settles and schedules another", async () => {
    // A fetch that ignores abort: something below the timeout never settles.
    const neverFetch = jest.fn(() => new Promise(() => {}));
    setFetch(neverFetch);
    const { client, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const state = client.routedHubClients["host-1"];
    expect(state.connectInFlight).toBeDefined();

    const stuck = state.connectInFlight;
    await jest.advanceTimersByTimeAsync(31_000);
    // The stuck attempt was dropped and a new one started with a new
    // bootstrap request, instead of joining the stuck one.
    expect(state.connectInFlight).not.toBe(stuck);
    expect(neverFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(`${state.lastConnectError}`).toMatch(/timeout/);
  });

  it("keeps reconnecting after an unexpected error in a reconnect run", async () => {
    setFetch(okFetch);
    const { client, eventHandlers, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const state = client.routedHubClients["host-1"];
    const refresh = jest
      .spyOn(client, "refreshHostRoutingInfo")
      .mockImplementationOnce(() => {
        throw new Error("unexpected");
      });
    eventHandlers.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalled();
    expect(state.reconnectTimer).toBeDefined();
  });

  it("reports a host that stays unreachable, and its recovery", async () => {
    setFetch(hangingFetch);
    const { eventHandlers, routedClient, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(59_000);
    expect(recordUxLatencyEvent).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(recordUxLatencyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "project_host_connection",
        metric: "stuck",
        host_id: "host-1",
      }),
    );

    routedClient.conn.connected = true;
    eventHandlers.connected?.();
    expect(recordUxLatencyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: "project_host_connection",
        metric: "recovered",
        host_id: "host-1",
        details: { was_stuck: true },
      }),
    );
  });

  it("does not report a routine quick reconnect", async () => {
    setFetch(okFetch);
    const { eventHandlers, routedClient, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    routedClient.conn.connected = true;
    eventHandlers.connected?.();
    routedClient.conn.connected = false;
    eventHandlers.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);
    routedClient.conn.connected = true;
    eventHandlers.connected?.();
    expect(recordUxLatencyEvent).not.toHaveBeenCalled();
  });
});
