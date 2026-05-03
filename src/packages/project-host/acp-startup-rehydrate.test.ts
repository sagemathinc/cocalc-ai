import { partitionAcpStartupProjectIds } from "./acp-startup-rehydrate";

describe("partitionAcpStartupProjectIds", () => {
  it("rehydrates only provisioned projects and identifies stale local rows", () => {
    expect(
      partitionAcpStartupProjectIds({
        provisionedProjectIds: ["project-1", "project-2", "project-3"],
        localAutomationProjectIds: [
          "project-2",
          "project-4",
          "project-2",
          "",
          " project-3 ",
        ],
      }),
    ).toEqual({
      rehydrateProjectIds: ["project-2", "project-3"],
      staleProjectIds: ["project-4"],
    });
  });
});
