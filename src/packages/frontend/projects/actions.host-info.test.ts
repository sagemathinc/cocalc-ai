import { Map as ImmutableMap } from "immutable";

jest.mock("@cocalc/util/async-utils", () => ({
  once: jest.fn(),
  withTimeout: jest.fn(async (_promise: Promise<any>) => {
    throw new Error("timeout");
  }),
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockedStore.get.mockImplementation((key) => {
      if (key === "host_info") {
        return ImmutableMap();
      }
      return undefined;
    });
  });

  it("returns undefined when host lookup times out instead of hanging", async () => {
    const redux = {
      getStore: jest.fn(() => ({})),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    await expect(actions.ensure_host_info("host-1")).resolves.toBeUndefined();

    expect(
      mockedWebappClient.conat_client.hub.hosts.resolveHostConnection,
    ).toHaveBeenCalledWith({
      host_id: "host-1",
    });
    expect(mockedWithTimeout).toHaveBeenCalledWith(expect.any(Promise), 5000);
    expect(redux._set_state).not.toHaveBeenCalled();
  });
});
