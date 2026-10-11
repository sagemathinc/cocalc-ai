/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { HostMaintenanceBanner } from "./host-maintenance-banner";
import { HostRecoveryBanner } from "./host-recovery-banner";
import { getHostRecoveryDisplay } from "@cocalc/frontend/projects/host-operational";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: () => <span>soon</span>,
}));

describe("HostMaintenanceBanner", () => {
  it("announces a scheduled window and can be dismissed", () => {
    render(
      <HostMaintenanceBanner
        maintenance={{
          state: "scheduled",
          kind: "maintenance",
          startsAt: "2030-01-02T03:00:00.000Z",
          expectedEndAt: "2030-01-02T03:10:00.000Z",
          expectedMinutes: 10,
          overdue: false,
          message: "Moving to a faster server.",
        }}
      />,
    );
    expect(screen.getByText(/Scheduled maintenance/)).toBeTruthy();
    expect(
      screen.getByText(/unavailable for about 10 minutes starting at/),
    ).toBeTruthy();
    expect(screen.getByText(/Moving to a faster server\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByText(/Scheduled maintenance/)).toBeNull();
  });

  it("explains a window in progress with the expected return", () => {
    render(
      <HostMaintenanceBanner
        maintenance={{
          state: "in_progress",
          kind: "relocation",
          startsAt: "2030-01-02T03:00:00.000Z",
          expectedEndAt: "2030-01-02T03:12:00.000Z",
          expectedMinutes: 12,
          overdue: false,
        }}
      />,
    );
    expect(
      screen.getByText(/This project's server is down for scheduled maintenance/),
    ).toBeTruthy();
    expect(screen.getByText(/Expected back around/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});

it("the reconnect banner leads with the maintenance window", () => {
  const recovery = getHostRecoveryDisplay(
    {
      status: "deprovisioned",
      maintenance: {
        kind: "relocation",
        state: "in_progress",
        started_at: "2030-01-02T03:00:00Z",
        expected_duration_ms: 12 * 60_000,
        expected_end_at: "2030-01-02T03:12:00Z",
      },
    },
    Date.parse("2030-01-02T03:05:00Z"),
  );
  render(
    <HostRecoveryBanner
      assignedHostLabel="us-south-2"
      canReconnectAutomatically
      hostUnavailableReason="Assigned host is deprovisioned."
      onCheckStatus={async () => {}}
      recovery={recovery}
    />,
  );
  expect(screen.getByText("Down for scheduled maintenance")).toBeTruthy();
  expect(screen.getByText(/^Expected back around/)).toBeTruthy();
});
