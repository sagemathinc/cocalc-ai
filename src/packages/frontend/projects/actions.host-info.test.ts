import { Map as ImmutableMap } from "immutable";

jest.mock("@cocalc/util/async-utils", () => ({
  ...jest.requireActual("@cocalc/util/async-utils"),
  withTimeout: jest.fn(async (promise: Promise<any>) => await promise),
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    conat_client: {
      conat: jest.fn(),
      hub: {
        hosts: {
          resolveHostConnection: jest.fn(() => new Promise(() => undefined)),
        },
      },
    },
    async_query: jest.fn(async () => undefined),
  },
}));

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withTimeout } from "@cocalc/util/async-utils";
import callHub from "@cocalc/conat/hub/call-hub";

const mockedStore = store as jest.Mocked<typeof store>;
const mockedWebappClient = webapp_client as jest.Mocked<typeof webapp_client>;
const mockedWithTimeout = withTimeout as jest.MockedFunction<
  typeof withTimeout
>;

describe("ProjectsActions ensure_host_info", () => {
  let hostInfo = ImmutableMap<string, any>();

  function createActions() {
    const redux = {
      getStore: jest.fn(() => ({})),
      _set_state: jest.fn((state) => {
        hostInfo = state.projects.host_info;
      }),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(),
    } as any;
    return {
      actions: new ProjectsActions("projects", redux),
      redux,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedWebappClient.account_id = "acct-1";
    mockedWebappClient.conat_client.conat.mockReturnValue({
      id: "client-1",
      info: { user: { account_id: "acct-1", auth_session_hash: "session-1" } },
    } as any);
    hostInfo = ImmutableMap();
    mockedStore.get.mockImplementation((key) => {
      if (key === "host_info") {
        return hostInfo;
      }
      return undefined;
    });
    mockedWithTimeout.mockImplementation(
      async (promise: Promise<any>) => await promise,
    );
  });

  it("returns undefined when host lookup times out instead of hanging", async () => {
    mockedWithTimeout.mockRejectedValueOnce(new Error("timeout"));
    const { actions, redux } = createActions();

    await expect(actions.ensure_host_info("host-1")).resolves.toBeUndefined();

    expect(
      mockedWebappClient.conat_client.hub.hosts.resolveHostConnection,
    ).toHaveBeenCalledWith({
      host_id: "host-1",
    });
    expect(mockedWithTimeout).toHaveBeenCalledWith(expect.any(Promise), 5000);
    expect(redux._set_state).not.toHaveBeenCalled();
  });

  it("coalesces forced and ordinary lookups for the same host", async () => {
    let resolveLookup!: (value: any) => void;
    const lookup = new Promise((resolve) => {
      resolveLookup = resolve;
    });
    mockedWebappClient.conat_client.hub.hosts.resolveHostConnection.mockReturnValueOnce(
      lookup,
    );
    const { actions } = createActions();

    const ordinary = actions.ensure_host_info("host-1");
    const forced = actions.ensure_host_info("host-1", true);

    expect(
      mockedWebappClient.conat_client.hub.hosts.resolveHostConnection,
    ).toHaveBeenCalledTimes(1);
    resolveLookup({ host_id: "host-1", connect_url: "https://host-1" });

    const [ordinaryResult, forcedResult] = await Promise.all([
      ordinary,
      forced,
    ]);
    expect(ordinaryResult?.get("host_id")).toBe("host-1");
    expect(forcedResult?.get("host_id")).toBe("host-1");
  });

  it("reuses the underlying RPC across 300 ordinary host-info timeout retries", async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      mockedWithTimeout.mockImplementation(
        jest.requireActual("@cocalc/util/async-utils").withTimeout,
      );
      let finish!: (value: any) => void;
      const request = jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const cn = mockedWebappClient.conat_client.conat();
      cn.request = request as any;
      mockedWebappClient.conat_client.hub.hosts.resolveHostConnection.mockImplementation(
        (opts) =>
          callHub({
            client: cn,
            account_id: "acct-1",
            name: "hosts.resolveHostConnection",
            args: [opts],
          }),
      );
      const { actions } = createActions();
      for (let i = 0; i < 300; i++) {
        const pending = actions.ensure_host_info("host-1", true);
        await jest.advanceTimersByTimeAsync(5_001);
        await expect(pending).resolves.toBeUndefined();
      }
      expect(request).toHaveBeenCalledTimes(1);
      const recovered = actions.ensure_host_info("host-1", true);
      finish({
        data: { host_id: "host-1", connect_url: "https://reconnected" },
      });
      expect((await recovered)?.get("connect_url")).toBe("https://reconnected");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it("merges concurrent host results into the latest host-info map", async () => {
    const resolves = new Map<string, (value: any) => void>();
    mockedWebappClient.conat_client.hub.hosts.resolveHostConnection.mockImplementation(
      ({ host_id }) =>
        new Promise((resolve) => {
          resolves.set(host_id, resolve);
        }),
    );
    const { actions } = createActions();

    const first = actions.ensure_host_info("host-1");
    const second = actions.ensure_host_info("host-2");
    resolves.get("host-1")?.({
      host_id: "host-1",
      connect_url: "https://host-1",
    });
    await first;
    resolves.get("host-2")?.({
      host_id: "host-2",
      connect_url: "https://host-2",
    });
    await second;

    expect(hostInfo.keySeq().toArray().sort()).toEqual(["host-1", "host-2"]);
  });

  it.each(["account", "session", "client"])(
    "does not join or publish an old %s scope, and old cleanup preserves the new flight",
    async (change) => {
      const completes: ((value: any) => void)[] = [];
      const resolver =
        mockedWebappClient.conat_client.hub.hosts.resolveHostConnection;
      resolver.mockImplementation(
        () => new Promise((resolve) => completes.push(resolve)),
      );
      const { actions, redux } = createActions();
      const old = actions.ensure_host_info("host-1");
      const cn = mockedWebappClient.conat_client.conat();
      if (change === "account") {
        mockedWebappClient.account_id = "acct-2";
      } else if (change === "session") {
        cn.info!.user!.auth_session_hash = "session-2";
      } else {
        mockedWebappClient.conat_client.conat.mockReturnValue({
          ...cn,
          id: "client-2",
        });
      }
      const current = actions.ensure_host_info("host-1");
      expect(resolver).toHaveBeenCalledTimes(2);
      completes[0]({ host_id: "host-1", connect_url: "https://old" });
      await expect(old).resolves.toBeUndefined();
      expect(redux._set_state).not.toHaveBeenCalled();
      const joined = actions.ensure_host_info("host-1", true);
      expect(resolver).toHaveBeenCalledTimes(2);
      completes[1]({ host_id: "host-1", connect_url: "https://current" });
      const [result, joinedResult] = await Promise.all([current, joined]);
      expect(result?.get("connect_url")).toBe("https://current");
      expect(joinedResult).toBe(result);
      expect(redux._set_state).toHaveBeenCalledTimes(1);
    },
  );

  it("backs off repeated best-effort lookups after any failure", async () => {
    mockedWithTimeout.mockRejectedValue(new Error("timeout"));
    const { actions } = createActions();

    await actions.ensure_host_info("host-1");
    await actions.ensure_host_info("host-1");
    await actions.ensure_host_info("host-1", true);

    expect(
      mockedWebappClient.conat_client.hub.hosts.resolveHostConnection,
    ).toHaveBeenCalledTimes(2);
  });
});
