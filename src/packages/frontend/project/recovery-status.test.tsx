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

it("explains a host memory block while project protection is still unknown", async () => {
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
    host_maintenance_block: {
      reason: "memory_pressure",
      checked_at: current(),
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="snapshot" />);
  expect(
    await screen.findByText(
      "Local snapshots: current protection status unknown",
    ),
  ).toBeVisible();
  expect(screen.getByText(/The host is under memory pressure/)).toBeVisible();
});

it("explains an unavailable memory measurement without claiming protection", async () => {
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
    host_maintenance_block: {
      reason: "memory_measurement_unavailable",
      checked_at: current(),
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="snapshot" />);
  expect(
    await screen.findByText(
      "Local snapshots: current protection status unknown",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/cannot verify memory pressure. Maintenance will retry/),
  ).toBeVisible();
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

it("explains a busy backup queue while keeping the due time visible", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    last_changed: "2026-09-22T00:00:00.000Z",
    last_backup: null,
    snapshot_due_at: null,
    backup_due_at: "2026-09-22T00:00:00.000Z",
    snapshot_disabled: false,
    backup_disabled: false,
    backup: {
      observed_at: current(),
      outcome: "deferred",
      reason: "backup_capacity_busy",
      due_at: "2026-09-22T00:00:00.000Z",
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="backup" />);
  expect(
    await screen.findByText(
      "Off-host backups: scheduled recovery point overdue",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/Backup workers are busy. This backup remains due/),
  ).toBeVisible();
});

it("shows a current host memory gate above an older attempt reason", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    last_changed: "2026-09-22T00:00:00.000Z",
    last_backup: null,
    snapshot_due_at: null,
    backup_due_at: "2026-09-22T00:00:00.000Z",
    snapshot_disabled: false,
    backup_disabled: false,
    host_maintenance_block: {
      reason: "memory_pressure",
      checked_at: current(),
    },
    backup: {
      observed_at: current(),
      outcome: "deferred",
      reason: "lifecycle_active",
      due_at: "2026-09-22T00:00:00.000Z",
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="backup" />);
  expect(
    await screen.findByText(
      "Off-host backups: scheduled recovery point overdue",
    ),
  ).toBeVisible();
  expect(screen.getByText(/The host is under memory pressure/)).toBeVisible();
  expect(screen.getByText(/Due .* Latest confirmed/)).toBeVisible();
});

it.each([
  [
    "io_pressure_unavailable",
    "The host cannot verify storage pressure. Maintenance will retry.",
  ],
  [
    "project_volume_lifecycle_changed",
    "Project storage changed during maintenance. Maintenance will retry.",
  ],
  [
    "legacy_restore_active",
    "Project restoration is in progress. Backups will retry afterward.",
  ],
  [
    "new backup is not confirmed in the repository",
    "The off-host backup could not be confirmed. Maintenance will retry.",
  ],
])("explains a blocked backup with reason %s", async (reason, message) => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    last_backup: null,
    backup_due_at: "2026-09-22T00:00:00.000Z",
    snapshot_disabled: false,
    backup_disabled: false,
    backup: {
      observed_at: current(),
      outcome: "deferred",
      reason,
      due_at: "2026-09-22T00:00:00.000Z",
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="backup" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(
    screen.getByText("Off-host backups: scheduled recovery point overdue"),
  ).toBeVisible();
});

it("explains an unconfirmed local snapshot", async () => {
  getRecoveryStatus.mockResolvedValue({
    project_id: "project-1",
    host_id: "host-1",
    host_last_seen: current(),
    snapshot_due_at: "2026-09-22T00:00:00.000Z",
    snapshot_disabled: false,
    backup_disabled: false,
    snapshot: {
      observed_at: current(),
      outcome: "deferred",
      reason: "snapshot_not_created",
      due_at: "2026-09-22T00:00:00.000Z",
    },
  });
  render(<ProjectRecoveryStatus project_id="project-1" kind="snapshot" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "A local snapshot has not been confirmed yet. Maintenance will retry.",
  );
});
