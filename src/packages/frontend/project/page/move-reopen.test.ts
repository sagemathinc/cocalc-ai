import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

import { reopenProjectAfterMove } from "./move-reopen";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
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

  it("dismisses the completed move before closing and reopening the project", async () => {
    await reopenProjectAfterMove({
      project_id: "83aefe84-6bcc-49fd-b4c7-67a1831efcf7",
      op_id: "move-op-1",
    });

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
  });
});
