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
  render(
    <WorkspaceSidebarActions
      firstNavigationItem={<button onClick={onProjects}>Projects</button>}
    />,
  );
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
      firstNavigationItem={<button>Projects</button>}
      footer={<button>Account menu</button>}
    >
      <button>Artifacts</button>
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
  for (const name of ["Projects", "Artifacts", "Last agent"])
    expect(within(scroll).getByRole("button", { name })).toBeVisible();
  expect(
    within(scroll).getByRole("textbox", { name: "Filter agents" }),
  ).toBeVisible();
  screen.getByRole("button", { name: "Last agent" }).focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
});

test("does not render a duplicate New Agent button above navigation", () => {
  render(
    <WorkspaceSidebarActions firstNavigationItem={<button>Projects</button>} />,
  );
  expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull();
});

test.each(["Projects", "Artifacts"])(
  "sidebar hide control shares the %s row without a spacer and is keyboard operable",
  async (name) => {
    const user = userEvent.setup();
    const onHideSidebar = jest.fn();
    render(
      <WorkspaceSidebarActions
        firstNavigationItem={<button>{name}</button>}
        onHideSidebar={onHideSidebar}
      />,
    );
    const scroll = screen.getByRole("region", {
      name: "Agent navigation and list",
    });
    const first = screen.getByRole("button", { name });
    const hide = screen.getByRole("button", { name: "Hide Agents sidebar" });
    expect(first.parentElement?.parentElement).toBe(hide.parentElement);
    expect(scroll).toContainElement(hide);
    expect(scroll.previousElementSibling).toBeNull();
    expect(scroll.style.marginTop).toBe("");
    expect(hide).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(scroll).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(hide).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onHideSidebar).toHaveBeenCalledTimes(1);
  },
);
