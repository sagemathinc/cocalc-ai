import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSidebarActions } from "./workspace-sidebar-actions";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span aria-hidden>{name}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

test("Projects navigation works from the keyboard", async () => {
  const user = userEvent.setup();
  const onProjects = jest.fn();
  render(<WorkspaceSidebarActions onProjects={onProjects} />);
  await user.tab();
  expect(
    screen.getByRole("region", { name: "Agent navigation and list" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Projects" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onProjects).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText(
      /Back to Projects|Your projects and courses are still here/,
    ),
  ).toBeNull();
});

test("account footer stays outside the keyboard-accessible navigation scroll area", async () => {
  const user = userEvent.setup();
  render(
    <WorkspaceSidebarActions
      onProjects={() => {}}
      footer={<button>Account menu</button>}
    >
      <button>Library</button>
      <input aria-label="Filter agents" />
      <button>Last agent</button>
    </WorkspaceSidebarActions>,
  );
  const scroll = screen.getByRole("region", {
    name: "Agent navigation and list",
  });
  expect(scroll).toHaveStyle({ overflowY: "auto", minHeight: 0 });
  expect(
    within(scroll).queryByRole("button", { name: "New Agent" }),
  ).toBeNull();
  expect(
    within(scroll).queryByRole("button", { name: "Account menu" }),
  ).toBeNull();
  for (const name of ["Projects", "Library", "Last agent"])
    expect(within(scroll).getByRole("button", { name })).toBeVisible();
  expect(
    within(scroll).getByRole("textbox", { name: "Filter agents" }),
  ).toBeVisible();
  screen.getByRole("button", { name: "Last agent" }).focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
});

test("does not render a duplicate New Agent button above navigation", () => {
  render(<WorkspaceSidebarActions />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("sidebar hide control is inside the sidebar and keyboard operable", async () => {
  const user = userEvent.setup();
  const onHideSidebar = jest.fn();
  render(<WorkspaceSidebarActions onHideSidebar={onHideSidebar} />);
  const hide = screen.getByRole("button", { name: "Hide Agents sidebar" });
  expect(hide).toHaveAttribute("aria-expanded", "true");
  await user.tab();
  expect(hide).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onHideSidebar).toHaveBeenCalledTimes(1);
});
