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

const mockSetState = jest.fn();
let mockCurrentTable:
  | {
      _table: MockSynctable;
    }
  | undefined;
const mockTables: MockSynctable[] = [];

const mockRedux = {
  createActions: jest.fn(),
  createStore: jest.fn(),
  createTable: jest.fn(() => {
    const table = new MockSynctable();
    mockTables.push(table);
    mockCurrentTable = { _table: table };
    return mockCurrentTable;
  }),
  getActions: jest.fn(() => ({
    setState: mockSetState,
  })),
  getStore: jest.fn(() => undefined),
  removeTable: jest.fn(() => {
    mockCurrentTable = undefined;
  }),
};

const mockWebappClient = {
  async_query: jest.fn(),
  is_signed_in: jest.fn(() => true),
  on: jest.fn(),
  conat_client: {
    on: jest.fn(),
  },
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: mockRedux,
  Store: class {},
  Actions: class {},
}));

jest.mock("@cocalc/frontend/app-framework/Table", () => ({
  Table: class {},
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: mockWebappClient,
}));

jest.mock("@cocalc/util/db-schema/groups", () => ({
  MAX_COLOR_LENGTH: 128,
  MAX_TITLE_LENGTH: 128,
}));

describe("groups table loading recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables.length = 0;
    mockCurrentTable = undefined;
    mockWebappClient.is_signed_in.mockReturnValue(true);
  });

  it("recreates the groups table if a stale table closes before connecting", async () => {
    const { refresh_groups_table } = await import("./redux");
    const refresh = refresh_groups_table();

    expect(mockTables).toHaveLength(1);
    mockTables[0].setState("closed");
    mockTables[0].emit("closed");

    await flush();

    expect(mockTables).toHaveLength(2);
    mockTables[1].setState("connected");
    mockTables[1].emit("connected");

    await expect(refresh).resolves.toBeUndefined();
    expect(mockRedux.createTable).toHaveBeenCalledTimes(2);
    expect(mockRedux.removeTable).toHaveBeenCalledTimes(2);
  });
});
