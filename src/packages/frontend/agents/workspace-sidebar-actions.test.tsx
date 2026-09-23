import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSidebarActions } from "./workspace-sidebar-actions";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
}));

test("quiet New Agent works from the keyboard without duplicate Projects navigation", async () => {
  const user = userEvent.setup();
  const onNewAgent = jest.fn();
  render(<WorkspaceSidebarActions onNewAgent={onNewAgent} />);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "New Agent" }),
  );
  await user.keyboard("{Enter}");
  expect(onNewAgent).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
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
