/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HostRecoveryBanner } from "./host-recovery-banner";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: () => <span>recently</span>,
}));

describe("HostRecoveryBanner", () => {
  it("keeps the explanation compact until requested", async () => {
    const onCheckStatus = jest.fn(async () => {});
    render(
      <HostRecoveryBanner
        assignedHostLabel="host2"
        canReconnectAutomatically
        hostUnavailableReason="Host heartbeat is stale."
        onCheckStatus={onCheckStatus}
        recovery={{
          active: false,
          startedAt: "2026-08-12T16:42:59.000Z",
          timingDescription: "This usually takes about 3 minutes.",
        }}
      />,
    );

    expect(screen.getByText("Reconnecting to your project")).toBeTruthy();
    expect(screen.getByText("Saved files are safe")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(
      screen.queryByText("CoCalc is reconnecting automatically."),
    ).toBeNull();

    const details = screen.getByRole("button", {
      name: /What's happening?/,
    });
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);

    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("CoCalc is reconnecting automatically."),
    ).toBeTruthy();
    expect(screen.getByText(/Technical status: host2/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    await waitFor(() => expect(onCheckStatus).toHaveBeenCalledTimes(1));
  });

  it("puts provider recovery detail behind the disclosure", () => {
    render(
      <HostRecoveryBanner
        assignedHostLabel="host2"
        canReconnectAutomatically
        hostUnavailableReason="Host is restarting."
        onCheckStatus={async () => {}}
        recovery={{
          active: true,
          description: "CoCalc switched this host to Standard capacity.",
          title: "Project host is restarting on guaranteed capacity",
        }}
      />,
    );

    expect(
      screen.queryByText("Project host is restarting on guaranteed capacity"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /What's happening?/ }));
    expect(
      screen.getByText("Project host is restarting on guaranteed capacity"),
    ).toBeTruthy();
    expect(
      screen.getByText(/CoCalc switched this host to Standard capacity/),
    ).toBeTruthy();
  });

  it("explains a failed manual refresh without disrupting recovery", async () => {
    render(
      <HostRecoveryBanner
        assignedHostLabel="host2"
        canReconnectAutomatically
        hostUnavailableReason="Host heartbeat is stale."
        onCheckStatus={async () => {
          throw Error("network error");
        }}
        recovery={{ active: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /What's happening?/ }));
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(
      await screen.findByText(/Status could not be refreshed just now/),
    ).toBeTruthy();
  });

  it("does not claim a deprovisioned host is reconnecting", () => {
    render(
      <HostRecoveryBanner
        assignedHostLabel="old-host"
        canReconnectAutomatically={false}
        hostUnavailableReason="Assigned host is deprovisioned."
        onCheckStatus={async () => {}}
        recovery={{ active: false }}
      />,
    );

    expect(screen.getByText("Project host is unavailable")).toBeTruthy();
    expect(
      screen.getByText("Automatic reconnection is not possible"),
    ).toBeTruthy();
    expect(screen.queryByText("Saved files are safe")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();

    const details = screen.getByRole("button", {
      name: /What can I do?/,
    });
    fireEvent.click(details);
    expect(
      screen.getByText(/CoCalc cannot reconnect automatically to old-host/),
    ).toBeTruthy();
    expect(
      screen.getByText(/move this project to an available host/),
    ).toBeTruthy();
  });
});
