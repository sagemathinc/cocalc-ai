import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSidebarActions } from "./workspace-sidebar-actions";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
}));

test("quiet New Agent and Projects navigation work from the keyboard", async () => {
  const user = userEvent.setup();
  const onNewAgent = jest.fn();
  const onProjects = jest.fn();
  render(
    <WorkspaceSidebarActions onNewAgent={onNewAgent} onProjects={onProjects} />,
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "New Agent" }),
  );
  await user.keyboard("{Enter}");
  expect(onNewAgent).toHaveBeenCalledTimes(1);
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

test("only New Agent stays outside the single keyboard-accessible scroll area", async () => {
  const user = userEvent.setup();
  render(
    <WorkspaceSidebarActions onNewAgent={() => {}} onProjects={() => {}}>
      <button>Library</button>
      <input aria-label="Filter agents" />
      <button>Last agent</button>
      <button>Account menu</button>
    </WorkspaceSidebarActions>,
  );
  const scroll = screen.getByRole("region", {
    name: "Agent navigation and list",
  });
  expect(scroll).toHaveStyle({ overflowY: "auto", minHeight: 0 });
  expect(
    within(scroll).queryByRole("button", { name: "New Agent" }),
  ).toBeNull();
  for (const name of ["Projects", "Library", "Last agent", "Account menu"])
    expect(within(scroll).getByRole("button", { name })).toBeVisible();
  expect(
    within(scroll).getByRole("textbox", { name: "Filter agents" }),
  ).toBeVisible();
  screen.getByRole("button", { name: "Last agent" }).focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
});

test("renders only New Agent in the sidebar action strip", () => {
  render(<WorkspaceSidebarActions onNewAgent={() => {}} />);
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
