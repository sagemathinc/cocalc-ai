import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSidebarActions } from "./workspace-sidebar-actions";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
}));

test("Projects precedes New Agent and both work from the keyboard", async () => {
  const user = userEvent.setup();
  const onProjects = jest.fn();
  const onNewAgent = jest.fn();
  render(
    <WorkspaceSidebarActions onProjects={onProjects} onNewAgent={onNewAgent} />,
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Projects" }),
  );
  await user.keyboard("{Enter}");
  expect(onProjects).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "New Agent" }),
  );
  await user.keyboard("{Enter}");
  expect(onNewAgent).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText(
      /Back to Projects|Your projects and courses are still here/,
    ),
  ).toBeNull();
});

test("supports environments without Projects navigation", () => {
  render(<WorkspaceSidebarActions onNewAgent={() => {}} />);
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
});
