import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

import { reopenProjectAfterMove } from "./move-reopen";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(),
    removeProjectReferences: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      releaseProjectHostRouting: jest.fn(),
      refreshProjectHostRouting: jest.fn(),
      hub: {
        lro: {
          dismiss: jest.fn(async () => undefined),
        },
      },
    },
  },
}));

describe("reopenProjectAfterMove", () => {
  const pageActions = {
    close_project_tab: jest.fn(),
  };
  const projectsActions = {
    ensure_host_info: jest.fn(async () => undefined),
    open_project: jest.fn(async () => undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (redux.getActions as jest.Mock).mockImplementation((name: string) => {
      if (name === "page") return pageActions;
      if (name === "projects") return projectsActions;
      throw new Error(`unexpected actions store: ${name}`);
    });
  });

  it("dismisses the completed move while closing and reopening the project", async () => {
    await reopenProjectAfterMove({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      op_id: "move-op-1",
      source_host_id: "source-host-1",
      dest_host_id: "dest-host-1",
    });

    expect(webapp_client.conat_client.hub.lro.dismiss).toHaveBeenCalledWith({
      op_id: "move-op-1",
    });
    expect(pageActions.close_project_tab).toHaveBeenCalledWith(
      "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
    );
    expect(
      webapp_client.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
    });
    expect(
      webapp_client.conat_client.refreshProjectHostRouting,
    ).toHaveBeenCalledWith({
      source_host_id: "source-host-1",
      dest_host_id: "dest-host-1",
    });
    expect(redux.removeProjectReferences).toHaveBeenCalledWith(
      "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
    );
    expect(projectsActions.ensure_host_info).toHaveBeenCalledWith(
      "dest-host-1",
      true,
    );
    expect(projectsActions.open_project).toHaveBeenCalledWith({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      switch_to: true,
      restore_session: true,
      change_history: true,
    });
  });

  it("still reopens the project when dismissing the completed move fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (
      webapp_client.conat_client.hub.lro.dismiss as jest.Mock
    ).mockRejectedValueOnce(new Error("timeout"));

    await reopenProjectAfterMove({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      op_id: "move-op-1",
    });
    await Promise.resolve();

    expect(webapp_client.conat_client.hub.lro.dismiss).toHaveBeenCalledWith({
      op_id: "move-op-1",
    });
    expect(pageActions.close_project_tab).toHaveBeenCalledWith(
      "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
    );
    expect(projectsActions.open_project).toHaveBeenCalledWith({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      switch_to: true,
      restore_session: true,
      change_history: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "failed to dismiss completed project move operation",
      expect.any(Error),
    );

    warn.mockRestore();
  });

  it("still reopens the project when refreshing destination host info fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    projectsActions.ensure_host_info.mockRejectedValueOnce(
      new Error("host-info timeout"),
    );

    await reopenProjectAfterMove({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      op_id: "move-op-1",
      dest_host_id: "dest-host-1",
    });

    expect(projectsActions.open_project).toHaveBeenCalledWith({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      switch_to: true,
      restore_session: true,
      change_history: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "failed to refresh destination host info before reopening moved project",
      expect.any(Error),
    );

    warn.mockRestore();
  });
});
