export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";

describe("host project ownership", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("accepts updates from the assigned host when bays match", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          current_host_id: HOST_ID,
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-a",
        },
      ],
    }));
    const { shouldDeleteHostProjectUpdate } =
      await import("./host-project-ownership");
    await expect(
      shouldDeleteHostProjectUpdate({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(false);
  });

  it("rejects updates from a non-owner host", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          current_host_id: "33333333-3333-3333-3333-333333333333",
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-a",
        },
      ],
    }));
    const { shouldDeleteHostProjectUpdate } =
      await import("./host-project-ownership");
    await expect(
      shouldDeleteHostProjectUpdate({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(true);
  });

  it("rejects updates when the assigned host bay mismatches the project bay", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          current_host_id: HOST_ID,
          project_owning_bay_id: "bay-a",
          host_bay_id: "bay-b",
        },
      ],
    }));
    const { shouldDeleteHostProjectUpdate } =
      await import("./host-project-ownership");
    await expect(
      shouldDeleteHostProjectUpdate({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe(true);
  });
});
