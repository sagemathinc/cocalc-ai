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
const mockPageStore = {
  get: jest.fn(() => undefined),
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
  getActions: jest.fn(() => ({
    setState: mockSetState,
  })),
  getStore: jest.fn(() => mockPageStore),
  getTable: jest.fn(() => mockCurrentTable),
  removeTable: jest.fn(() => {
    mockCurrentTable = undefined;
  }),
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

describe("projects table loading recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables.length = 0;
    mockCurrentTable = undefined;
    mockPageStore.get.mockReturnValue(undefined);
  });

  it("recreates the projects table if a stale table closes before connecting", async () => {
    const { refresh_projects_table } = await import("./table");
    const refresh = refresh_projects_table();

    expect(mockTables).toHaveLength(1);
    mockTables[0].setState("closed");
    mockTables[0].emit("closed");

    await flush();

    expect(mockTables).toHaveLength(2);
    mockTables[1].setState("connected");
    mockTables[1].emit("connected");

    await expect(refresh).resolves.toBeUndefined();
    expect(mockRedux.createTable).toHaveBeenCalledTimes(2);
  });
});
