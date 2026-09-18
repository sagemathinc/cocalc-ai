/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsSidebarToggle } from "./workspace-sidebar-toggle";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden>{name}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("AgentsSidebarToggle", () => {
  it("exposes the expanded state and hides the Agents sidebar", () => {
    const onToggle = jest.fn();
    render(<AgentsSidebarToggle hidden={false} onToggle={onToggle} />);

    const button = screen.getByRole("button", {
      name: "Hide Agents sidebar",
    });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "agents-workspace-sidebar");

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers to show the collapsed Agents sidebar", () => {
    render(<AgentsSidebarToggle hidden onToggle={jest.fn()} />);

    expect(
      screen.getByRole("button", { name: "Show Agents sidebar" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
