/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const createHostStatusServiceMock = jest.fn();
const queryMock = jest.fn();
const appendProjectOutboxEventForProjectMock = jest.fn();
const publishProjectAccountFeedEventsBestEffortMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostStatusService: (...args: any[]) =>
    createHostStatusServiceMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    connect: async () => ({
      query: (...args: any[]) => queryMock(...args),
      release: jest.fn(),
    }),
  })),
}));

jest.mock("./host-project-ownership", () => ({
  classifyHostProvisionedInventory: jest.fn(),
  shouldDeleteHostProjectUpdate: jest.fn(async () => false),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));

describe("host status project state ordering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createHostStatusServiceMock.mockImplementation(async ({ impl }) => impl);
    queryMock.mockImplementation(async (sql: string) => ({
      rows: [],
      rowCount: sql.includes("UPDATE projects") ? 0 : undefined,
    }));
  });

  it("preserves event time and rejects reports older than authoritative state", async () => {
    const { initHostStatusService } = await import("./host-status");
    const service = await initHostStatusService();

    await service.reportProjectState({
      host_id: "host-1",
      project_id: "project-1",
      state: {
        state: "starting",
        time: new Date("2026-07-31T01:00:00.000Z"),
      },
    });

    const update = queryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE projects"),
    );
    expect(update).toBeDefined();
    expect(update[0]).toContain("state->>'time' <= $3::text");
    expect(update[1]).toEqual([
      "project-1",
      {
        state: "starting",
        time: "2026-07-31T01:00:00.000Z",
      },
      "2026-07-31T01:00:00.000Z",
    ]);
    expect(appendProjectOutboxEventForProjectMock).not.toHaveBeenCalled();
    expect(
      publishProjectAccountFeedEventsBestEffortMock,
    ).not.toHaveBeenCalled();
  });
});
