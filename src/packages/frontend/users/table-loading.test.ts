/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

class MockSynctable extends EventEmitter {
  private state = "connecting";

  get_state(): string {
    return this.state;
  }

  setState(state: string): void {
    this.state = state;
  }
}

const mockPageStore = {
  get: jest.fn(() => undefined),
};
const mockAccountStore = {
  get: jest.fn(() => undefined),
  on: jest.fn(),
  removeListener: jest.fn(),
};
let mockCurrentTable:
  | {
      _table: MockSynctable;
    }
  | undefined;
const mockTables: MockSynctable[] = [];

const mockRedux = {
  createTable: jest.fn(() => {
    const table = new MockSynctable();
    mockTables.push(table);
    mockCurrentTable = { _table: table };
    return mockCurrentTable;
  }),
  getStore: jest.fn((name: string) => {
    if (name === "page") {
      return mockPageStore;
    }
    if (name === "account") {
      return mockAccountStore;
    }
    return undefined;
  }),
  removeTable: jest.fn(() => {
    mockCurrentTable = undefined;
  }),
  reduxStore: {
    subscribe: jest.fn(() => jest.fn()),
  },
};

const mockWebappClient = {
  is_signed_in: jest.fn(() => false),
  on: jest.fn(),
  conat_client: {
    on: jest.fn(),
  },
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

jest.mock("../app-framework", () => ({
  redux: mockRedux,
  Table: class {},
}));

jest.mock("../fullscreen", () => ({
  COCALC_MINIMAL: false,
}));

jest.mock("../webapp-client", () => ({
  webapp_client: mockWebappClient,
}));

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: jest.fn(),
}));

jest.mock("./actions", () => ({
  actions: {
    setState: jest.fn(),
  },
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn(() => undefined),
  },
}));

describe("users table loading recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables.length = 0;
    mockCurrentTable = undefined;
    mockPageStore.get.mockReturnValue(undefined);
    mockAccountStore.get.mockReturnValue(undefined);
    mockWebappClient.is_signed_in.mockReturnValue(false);
  });

  it("recreates the users table if a stale refresh table closes before connecting", async () => {
    const { recreate_users_table } = await import("./table");
    mockTables.length = 0;
    mockCurrentTable = undefined;
    mockRedux.createTable.mockClear();
    mockRedux.removeTable.mockClear();

    recreate_users_table();

    expect(mockTables).toHaveLength(1);
    mockTables[0].setState("closed");
    mockTables[0].emit("closed");

    await flush();

    expect(mockTables).toHaveLength(2);
    mockTables[1].setState("connected");
    mockTables[1].emit("connected");

    await flush();

    expect(mockRedux.createTable).toHaveBeenCalledTimes(2);
    expect(mockRedux.removeTable).toHaveBeenCalledTimes(2);
  });
});
