/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigProvider, theme } from "antd";
import { fromJS } from "immutable";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import StartInProgress from "./start-in-progress";
import BackupOps from "../explorer/backup-ops";
import CopyOps from "../explorer/copy-ops";
import RestoreOps from "../explorer/restore-ops";
import MoveOps from "../explorer/move-ops";
import RootfsPublishOps from "../settings/rootfs-publish-ops";

const mockOperation = fromJS({
  op_id: "operation",
  summary: { status: "running", started_at: "2026-01-01T00:00:00Z" },
  last_progress: {
    phase: "queued",
    message: "Preparing operation",
    progress: 10,
  },
});
jest.mock("@cocalc/frontend/app-framework", () => ({
  useProjectMapField: () => "starting",
  useTypedRedux: (_, key) => {
    if (key === "restart_request") return undefined;
    if (key === "start_lro" || key === "move_lro") return mockOperation;
    return fromJS({ operation: mockOperation.toJS() });
  },
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ is_active: true, actions: {} }),
}));
jest.mock("../use-project-active-op", () => ({
  useProjectActiveOperation: () => ({}),
}));
jest.mock("../use-project-start-state-reconcile", () => ({
  useProjectStartStateReconcile: jest.fn(),
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => <span>Recently</span>,
}));
jest.mock("@cocalc/frontend/users/user", () => ({
  User: () => <span>User</span>,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

describe.each(["light", "dark"])("project progress in %s mode", (mode) => {
  function themed(element) {
    return (
      <ConfigProvider
        theme={{
          algorithm:
            mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
      >
        {element}
      </ConfigProvider>
    );
  }

  it("pairs startup text and surface tokens and retains keyboard dismissal", async () => {
    const user = userEvent.setup();
    const { container } = render(
      themed(<StartInProgress project_id="project" />),
    );
    expect(await screen.findByText("Starting project")).toBeVisible();
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.background).toBe(UI_COLORS.surface);
    expect(panel.style.color).toBe(UI_COLORS.text);
    expect(screen.getByText("Preparing operation").style.color).toBe(
      UI_COLORS.text,
    );
    const dismiss = screen.getByRole("button", {
      name: "Dismiss startup banner",
    });
    dismiss.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("Starting project")).toBeNull();
  });

  it.each([
    ["backup", BackupOps, "Timeline"],
    ["copy", CopyOps, "Timeline"],
    ["restore", RestoreOps, "Timeline"],
    ["move", MoveOps, "Details"],
    ["publish", RootfsPublishOps, "Timeline"],
  ] as const)(
    "themes the %s card and its timeline",
    async (_, Component, label) => {
      const user = userEvent.setup();
      const { container } = render(themed(<Component project_id="project" />));
      const panel = container.firstElementChild as HTMLElement;
      expect(panel.style.background).toBe(UI_COLORS.surface);
      expect(panel.style.color).toBe(UI_COLORS.text);
      const trigger = screen.getByRole("button", { name: label });
      trigger.focus();
      await user.keyboard("{Enter}");
      const popup = await screen.findByRole("tooltip");
      await waitFor(() => expect(popup).toBeVisible());
      const secondary =
        popup.querySelectorAll<HTMLElement>('[style*="color:"]');
      expect(
        [...secondary].some((node) => node.style.color === UI_COLORS.secondary),
      ).toBe(true);
    },
  );
});
