/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsSidebarToggle } from "./workspace-sidebar-toggle";

let mockNotificationCount = 0;
const mockSetActiveTab = jest.fn();
jest.mock("@cocalc/frontend/art", () => ({ APP_ICON: "/logo.svg" }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ set_active_tab: mockSetActiveTab }) },
}));
jest.mock("@cocalc/frontend/app/notifications", () => ({
  NOTIFICATION_BADGE_MAX: 99,
  useNotificationCount: () => mockNotificationCount,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden>{name}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("AgentsSidebarToggle", () => {
  it("exposes the expanded state and hides the Agents sidebar", () => {
    const onToggle = jest.fn();
    render(<AgentsSidebarToggle hidden={false} onToggle={onToggle} />);

    const button = screen.getByRole("button", {
      name: "Hide sidebar",
    });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "agents-workspace-sidebar");

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers to show the collapsed Agents sidebar", () => {
    render(<AgentsSidebarToggle hidden onToggle={jest.fn()} />);

    expect(
      screen.getByRole("button", { name: "Show sidebar" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("hidden, shows the CoCalc mark so the way back is easy to spot", () => {
    const { container } = render(
      <AgentsSidebarToggle hidden onToggle={jest.fn()} />,
    );
    expect(container.querySelector('img[src="/logo.svg"]')).not.toBeNull();
  });

  it("hidden, carries the unread count on the logo and opens notifications from it", () => {
    mockNotificationCount = 120;
    const onToggle = jest.fn();
    render(<AgentsSidebarToggle hidden onToggle={onToggle} />);
    const badge = screen.getByRole("button", {
      name: "120 unread notifications",
    });
    expect(badge).toHaveTextContent("99+");
    fireEvent.click(badge);
    expect(mockSetActiveTab).toHaveBeenCalledWith("notifications");
    expect(onToggle).not.toHaveBeenCalled();
    mockNotificationCount = 0;
  });

  it("shows no count when there is nothing unread", () => {
    render(<AgentsSidebarToggle hidden onToggle={jest.fn()} />);
    expect(screen.queryByRole("button", { name: /unread/ })).toBeNull();
  });
});
