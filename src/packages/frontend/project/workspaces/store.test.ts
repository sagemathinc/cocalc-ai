import { openWorkspaceStore } from "@cocalc/conat/workspaces";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  isWorkspaceStoreRoutingPendingError,
  openProjectWorkspaceStore,
} from "./store";

jest.mock("@cocalc/conat/workspaces", () => ({
  openWorkspaceStore: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: jest.fn(),
    },
  },
}));

describe("project workspace store routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens workspace stores through a routed project client", async () => {
    (webapp_client.conat_client.projectConat as jest.Mock).mockResolvedValue(
      "project-client",
    );
    (openWorkspaceStore as jest.Mock).mockResolvedValue("workspace-store");

    await expect(
      openProjectWorkspaceStore({
        project_id: "00000000-0000-4000-8000-000000000111",
        account_id: "account-1",
        caller: "test",
      }),
    ).resolves.toBe("workspace-store");

    expect(webapp_client.conat_client.projectConat).toHaveBeenCalledWith({
      project_id: "00000000-0000-4000-8000-000000000111",
      account_id: undefined,
      caller: "test",
      requireRouting: true,
    });
    expect(openWorkspaceStore).toHaveBeenCalledWith({
      client: "project-client",
      project_id: "00000000-0000-4000-8000-000000000111",
      account_id: "account-1",
    });
  });

  it("treats missing project-host routing as retryable", () => {
    expect(
      isWorkspaceStoreRoutingPendingError(
        new Error(
          "unable to route 'useProjectWorkspaces' to project-host for project p; host routing info unavailable",
        ),
      ),
    ).toBe(true);
    expect(
      isWorkspaceStoreRoutingPendingError(
        new Error(
          "unable to route 'useProjectWorkspaces' to project-host for project p; project host id unavailable",
        ),
      ),
    ).toBe(true);
    expect(
      isWorkspaceStoreRoutingPendingError(new Error("workspace not found")),
    ).toBe(false);
  });
});
