/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { ProjectRecoveryStatus } from "./recovery-status";

const getRecoveryStatus = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getRecoveryStatus: (opts: any) => getRecoveryStatus(opts),
        },
      },
    },
  },
}));

const current = () => new Date().toISOString();

beforeEach(() => {
  getRecoveryStatus.mockReset();
});

it("announces an overdue snapshot with the latest confirmed recovery point", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    last_changed: "2026-09-22T00:00:00.000Z",
    last_backup: null,
    snapshot_due_at: "2026-09-22T00:00:00.000Z",
    backup_due_at: null,
    snapshot_disabled: false,
    backup_disabled: false,
    snapshot: {
      observed_at: current(),
      outcome: "failed",
      reason: "Disk quota exceeded",
      due_at: "2026-09-22T00:00:00.000Z",
      latest_snapshot_at: "2026-09-20T00:00:00.000Z",
    },
  });
  const { container } = render(
    <ProjectRecoveryStatus project_id="project-1" kind="snapshot" />,
  );
  expect(
    await screen.findByText(
      /Local snapshots: scheduled recovery point overdue/,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/Storage quota is blocking maintenance/),
  ).toBeVisible();
  expect(container.querySelector('[aria-live="assertive"]')).not.toBeNull();
  expect(getRecoveryStatus).toHaveBeenCalledWith({ project_id: "project-1" });
});

it("shows unknown status when the host has stopped reporting", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: "2026-09-20T00:00:00.000Z",
    last_changed: null,
    last_backup: "2026-09-20T00:00:00.000Z",
    snapshot_due_at: null,
    backup_due_at: null,
    snapshot_disabled: false,
    backup_disabled: false,
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="backup" />);
  expect(
    await screen.findByText(
      /Off-host backups: current protection status unknown/,
    ),
  ).toBeVisible();
});

it("shows overdue recovery debt even when the host status is unknown", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: "2026-09-20T00:00:00.000Z",
    last_changed: "2026-09-22T00:00:00.000Z",
    last_backup: null,
    snapshot_due_at: "2026-09-22T00:00:00.000Z",
    backup_due_at: null,
    snapshot_disabled: false,
    backup_disabled: false,
  });
  const { container } = render(
    <ProjectRecoveryStatus project_id="project-1" kind="snapshot" />,
  );
  expect(
    await screen.findByText(
      "Local snapshots: current protection status unknown",
    ),
  ).toBeVisible();
  expect(screen.getByText(/Scheduled recovery point was due/)).toBeVisible();
  expect(container.querySelector('[aria-live="assertive"]')).not.toBeNull();
});

it("does not claim protection when unchanged content has no recovery point", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    last_changed: current(),
    last_backup: null,
    snapshot_due_at: null,
    backup_due_at: null,
    snapshot_disabled: false,
    backup_disabled: false,
    snapshot: {
      observed_at: current(),
      outcome: "skipped",
      reason: "no_content_change",
      due_at: null,
      latest_snapshot_at: null,
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="snapshot" />);
  expect(
    await screen.findByText("Local snapshots: no confirmed recovery point"),
  ).toBeVisible();
  expect(
    screen.getByText("The last check found no changed content to protect."),
  ).toBeVisible();
});
