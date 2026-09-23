import React from "react";
import { render, screen } from "@testing-library/react";
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
  expect(screen.getByRole("button", { name: "Projects" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onProjects).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText(
      /Back to Projects|Your projects and courses are still here/,
    ),
  ).toBeNull();
});

test("renders only New Agent in the sidebar action strip", () => {
  render(<WorkspaceSidebarActions onNewAgent={() => {}} />);
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
