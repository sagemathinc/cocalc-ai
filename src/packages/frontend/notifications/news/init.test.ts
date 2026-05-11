import { Map, Set as ImmutableSet } from "immutable";

const mockNewsState: any = {};
let mockNewsStore: any;
let mockModuleActions: any;
let mockAccountStore: any;

const mockSetState = jest.fn((patch: any) => {
  Object.assign(mockNewsState, patch);
});

const mockRedux: any = {
  createStore: jest.fn((name: string, StoreClass: any, initial: any) => {
    Object.assign(mockNewsState, initial);
    mockNewsStore = new StoreClass(name, mockRedux);
    return mockNewsStore;
  }),
  createActions: jest.fn((name: string, ActionsClass: any) => {
    mockModuleActions = new ActionsClass(name, mockRedux);
    return mockModuleActions;
  }),
  getActions: jest.fn((name: string) => {
    if (name === "account") {
      return { setState: jest.fn() };
    }
    if (name === "news") {
      return mockModuleActions;
    }
  }),
  getStore: jest.fn((name: string) => {
    if (name === "account") {
      return mockAccountStore;
    }
    if (name === "news") {
      return mockNewsStore;
    }
  }),
  getTable: jest.fn(() => ({ set: jest.fn() })),
};

jest.mock("@cocalc/frontend/app-framework", () => {
  class MockActions {
    public name: string;
    public redux: any;

    constructor(name: string, redux: any) {
      this.name = name;
      this.redux = redux;
    }

    public setState(patch: any): void {
      mockSetState(patch);
    }
  }

  class MockStore {
    public name: string;
    public redux: any;

    constructor(name: string, redux: any) {
      this.name = name;
      this.redux = redux;
    }

    public get(key: string): any {
      return mockNewsState[key];
    }
  }

  return {
    Actions: MockActions,
    createTypedMap: () =>
      class {
        constructor(value: any) {
          const { fromJS } = require("immutable");
          return fromJS(value);
        }
      },
    redux: mockRedux,
    Store: MockStore,
  };
});

const mockNotification = {
  destroy: jest.fn(),
  warning: jest.fn(),
};

jest.mock("@cocalc/frontend/app/antd-notification", () => ({
  getAntdNotificationInstance: () => mockNotification,
}));

const mockGetSharedAccountDkv = jest.fn();

jest.mock("@cocalc/frontend/conat/account-dkv", () => ({
  getSharedAccountDkv: mockGetSharedAccountDkv,
}));

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: jest.fn(),
}));

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: () => null,
}));

const mockListNews = jest.fn();
const mockWebappClient = {
  is_signed_in: jest.fn(() => true),
  server_time: jest.fn(() => new Date("2026-05-11T12:00:00Z")),
  conat_client: {
    hub: {
      system: {
        listNews: mockListNews,
      },
    },
  },
  on: jest.fn(),
};

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: mockWebappClient,
}));

import { NewsActions } from "./init";

describe("news notifications loading recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockNewsState, {
      loading: true,
      unread: 0,
      news: Map(),
      system_seen_ids: ImmutableSet<string>(),
    });
    mockWebappClient.is_signed_in.mockReturnValue(true);
    mockListNews.mockResolvedValue([]);
    mockGetSharedAccountDkv.mockResolvedValue({
      getAll: () => ({}),
      isClosed: () => false,
      on: jest.fn(),
      off: jest.fn(),
    });
  });

  it("does not leave news refresh loading when account readiness is stale", async () => {
    mockAccountStore = {
      async_wait: jest.fn(({ timeout }) => {
        if (timeout === 0) {
          return new Promise(() => undefined);
        }
        return Promise.reject(new Error("account wait timed out"));
      }),
      get: jest.fn(() => undefined),
      get_account_id: jest.fn(() => undefined),
    };
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const actions = new NewsActions("news", mockRedux);

    try {
      await actions.refresh();
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockAccountStore.async_wait).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: expect.any(Number),
      }),
    );
    expect(
      mockAccountStore.async_wait.mock.calls[0][0].timeout,
    ).toBeGreaterThan(0);
    expect(mockGetSharedAccountDkv).not.toHaveBeenCalled();
    expect(mockListNews).toHaveBeenCalledTimes(1);
    expect(mockNewsState.loading).toBe(false);
  });
});
