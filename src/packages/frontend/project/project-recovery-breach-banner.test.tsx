/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectRecoveryStatus } from "@cocalc/conat/hub/api/projects";
import {
  ProjectRecoveryBreachAlert,
  ProjectRecoveryBreachBanner,
} from "./project-recovery-breach-banner";

const getRecoveryStatus = jest.fn();
const setState = jest.fn();
const setActiveTab = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({ setState, set_active_tab: setActiveTab }),
}));
jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getRecoveryStatus: (...args: any[]) => getRecoveryStatus(...args),
        },
      },
    },
  },
}));

function recoveryStatus(
  serviceClass: ProjectRecoveryStatus["storage_service_class"],
  overrides: Partial<ProjectRecoveryStatus> = {},
): ProjectRecoveryStatus {
  return {
    storage_service_class: serviceClass,
    snapshot_disabled: false,
    backup_disabled: false,
    snapshot_due_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    backup_due_at: new Date(Date.now() - 13 * 60 * 60_000).toISOString(),
    ...overrides,
  } as ProjectRecoveryStatus;
}

describe("ProjectRecoveryBreachBanner", () => {
  beforeEach(() => {
    getRecoveryStatus.mockReset();
    setState.mockReset();
    setActiveTab.mockReset();
  });

  it("alerts a paying collaborator to both breached recovery obligations and opens the chosen view by keyboard", async () => {
    const user = userEvent.setup();
    getRecoveryStatus.mockResolvedValue(recoveryStatus("paying"));
    render(<ProjectRecoveryBreachBanner project_id="project-1" />);

    const snapshotButton = await screen.findByRole("button", {
      name: "Review snapshots",
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Project recovery is delayed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review backups" })).toBeTruthy();
    snapshotButton.focus();
    expect(snapshotButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(setState).toHaveBeenCalledWith({
      find_tab: "snapshots",
      find_scope_mode: "home",
      find_scope_path: "/home/user",
    });
    expect(setActiveTab).toHaveBeenCalledWith("search");
    expect(getRecoveryStatus).toHaveBeenCalledWith({ project_id: "project-1" });
  });

  it("does not show a paying incident warning for free or disabled schedules", async () => {
    const onReview = jest.fn();
    const { rerender } = render(
      <ProjectRecoveryBreachAlert
        status={recoveryStatus("free")}
        onReview={onReview}
      />,
    );
    expect(screen.queryByText("Project recovery is delayed")).toBeNull();

    rerender(
      <ProjectRecoveryBreachAlert
        status={recoveryStatus("paying", {
          snapshot_disabled: true,
          backup_disabled: true,
        })}
        onReview={onReview}
      />,
    );
    expect(screen.queryByText("Project recovery is delayed")).toBeNull();
  });
});
