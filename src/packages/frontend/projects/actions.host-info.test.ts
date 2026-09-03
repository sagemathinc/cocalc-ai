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
