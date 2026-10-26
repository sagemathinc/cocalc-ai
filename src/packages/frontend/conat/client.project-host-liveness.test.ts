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
  // One fake routed client per connection; routed() is the latest.
  const created: any[] = [];
  const makeRoutedClient = () => {
    const eventHandlers: Record<string, Function> = {};
    const connHandlers: Record<string, Function> = {};
    const routed = {
      eventHandlers,
      connHandlers,
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
      connect: jest.fn(),
      close: jest.fn(),
      request: jest.fn(),
      disconnect: jest.fn(() => {
        routed.conn.connected = false;
      }),
      info: undefined as any,
    };
    created.push(routed);
    return routed;
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
      opts?.address === "http://project-host" ? makeRoutedClient() : hubClient,
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
  const routed = () => created[created.length - 1];
  // the host connects and signs in
  const signIn = (r = routed()) => {
    r.conn.connected = true;
    r.eventHandlers.connected?.();
    r.info = { user: { account_id: "acct-1" } };
    r.eventHandlers.info?.(r.info);
  };
  return { client, routed, created, addHost, signIn };
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
    const { client, routed, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    expect(routed().connect).not.toHaveBeenCalled();
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
    expect(routed().connect).toHaveBeenCalled();
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

  it("gives a joined attempt one deadline, not one per caller", async () => {
    // a fetch that ignores abort, so the first attempt lasts to its deadline
    setFetch(jest.fn(() => new Promise(() => {})));
    const { client, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const state = client.routedHubClients["host-1"];
    const first = state.connectInFlight;
    // a second caller joins the same attempt at about 20 s
    await jest.advanceTimersByTimeAsync(19_000);
    void client.connectRoutedHost({ routing_key: "host-1", state });
    expect(state.connectInFlight).toBe(first);

    // the attempt's own deadline (about 30 s) replaces it ...
    await jest.advanceTimersByTimeAsync(12_000);
    const second = state.connectInFlight;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    const secondBootstrap =
      client.projectHostBrowserSessions["host-1"]?.inFlight;
    expect(secondBootstrap).toBeDefined();

    // ... and the late joiner adds no second deadline (it would fire at about
    // 50 s) that drops the newer attempt or its bootstrap; the newer attempt's
    // own deadline is at about 61 s.
    await jest.advanceTimersByTimeAsync(20_000);
    expect(state.connectInFlight).toBe(second);
    expect(client.projectHostBrowserSessions["host-1"]?.inFlight).toBe(
      secondBootstrap,
    );
  });

  it("keeps reconnecting after an unexpected error in a reconnect run", async () => {
    setFetch(okFetch);
    const { client, routed, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const state = client.routedHubClients["host-1"];
    const refresh = jest
      .spyOn(client, "refreshHostRoutingInfo")
      .mockImplementationOnce(() => {
        throw new Error("unexpected");
      });
    routed().eventHandlers.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalled();
    expect(state.reconnectTimer).toBeDefined();
  });

  it("reports a host that stays unreachable, and its recovery", async () => {
    setFetch(hangingFetch);
    const { signIn, addHost } = setup();
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

    signIn();
    expect(recordUxLatencyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_type: "project_host_connection",
        metric: "recovered",
        host_id: "host-1",
        details: { was_stuck: true },
      }),
    );
  });

  it("does not treat a transport connection without sign-in as recovered", async () => {
    setFetch(okFetch);
    const { routed, signIn, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    // transport up, but no successful sign-in (info) yet
    routed().conn.connected = true;
    routed().eventHandlers.connected?.();
    await jest.advanceTimersByTimeAsync(61_000);
    expect(recordUxLatencyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "stuck" }),
    );
    expect(recordUxLatencyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: "recovered" }),
    );
    signIn();
    expect(recordUxLatencyEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ metric: "recovered" }),
    );
  });

  it("does not report a routine quick reconnect", async () => {
    setFetch(okFetch);
    const { routed, signIn, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    signIn();
    routed().conn.connected = false;
    routed().eventHandlers.disconnected?.();
    await jest.advanceTimersByTimeAsync(1_000);
    signIn();
    expect(recordUxLatencyEvent).not.toHaveBeenCalled();
  });

  it("ignores a hung bootstrap of a client that was replaced", async () => {
    setFetch(hangingFetch);
    const { client, created, signIn, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const old = client.routedHubClients["host-1"];

    // the client is replaced (e.g. the route changed) and the new one signs in
    client.removeRoutedHubClient("host-1", { reason: "test" });
    client.invalidateProjectHostBrowserSession("host-1");
    setFetch(okFetch);
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(2);
    signIn(created[1]);

    const disconnected = jest.fn();
    client.on("project-host-disconnected", disconnected);
    // the old client's bootstrap now times out
    await jest.advanceTimersByTimeAsync(60_000);
    expect(disconnected).not.toHaveBeenCalled();
    expect(old.reconnectTimer).toBeUndefined();
    expect(old.stuckTimer).toBeUndefined();
    expect(recordUxLatencyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ metric: "stuck" }),
    );
  });

  it("reconnects a transport connection that never signs in", async () => {
    setFetch(okFetch);
    const { client, routed, signIn, addHost } = setup();
    addHost();
    await jest.advanceTimersByTimeAsync(1_000);
    const r = routed();
    expect(r.connect).toHaveBeenCalledTimes(1);
    // transport up, but the host never signs us in
    r.conn.connected = true;
    r.eventHandlers.connected?.();
    await jest.advanceTimersByTimeAsync(19_000);
    expect(r.disconnect).not.toHaveBeenCalled();

    // after the sign-in deadline the connection is torn down and a new
    // connect attempt is made
    await jest.advanceTimersByTimeAsync(3_000);
    expect(r.disconnect).toHaveBeenCalled();
    expect(r.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(`${client.routedHubClients["host-1"].lastConnectError}`).toMatch(
      /not signed in/,
    );

    // a successful sign-in on the next connection stops the cycle
    signIn(r);
    const calls = r.connect.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(r.connect.mock.calls.length).toBe(calls);
  });
});
