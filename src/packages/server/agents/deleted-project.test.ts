const local = jest.fn();
const remote = jest.fn();
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterBayIdsForStaticEnumerationOnly: () => ["home", "owner"],
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    projectControl: () => ({ hardDeleteStatus: remote }),
  }),
}));
jest.mock("@cocalc/server/projects/hard-delete-evidence", () => ({
  getAuthoritativeProjectHardDeleteStatus: local,
}));
import { agentProjectWasDeleted } from "./deleted-project";
beforeEach(() => {
  local
    .mockReset()
    .mockResolvedValue({ project_id: "p", bay_id: "home", status: "unknown" });
  remote
    .mockReset()
    .mockResolvedValue({
      project_id: "p",
      bay_id: "owner",
      status: "hard-deleted",
    });
});
it("recognizes deletion on a different owning bay", async () => {
  await expect(agentProjectWasDeleted("p")).resolves.toBe(true);
});
it.each(["live", "unknown"])(
  "does not retire a project with %s evidence",
  async (status) => {
    remote.mockResolvedValue({ project_id: "p", bay_id: "owner", status });
    await expect(agentProjectWasDeleted("p")).resolves.toBe(false);
  },
);
it("does not mistake an outage for deletion", async () => {
  local.mockResolvedValue({
    project_id: "p",
    bay_id: "home",
    status: "hard-deleted",
  });
  remote.mockRejectedValue(new Error("timeout"));
  await expect(agentProjectWasDeleted("p")).resolves.toBe(false);
});
it("rejects mismatched project evidence", async () => {
  remote.mockResolvedValue({
    project_id: "other",
    bay_id: "owner",
    status: "hard-deleted",
  });
  await expect(agentProjectWasDeleted("p")).resolves.toBe(false);
});
