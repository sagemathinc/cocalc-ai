import { fireEvent, render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { NavTab } from "./nav-tab";

const setActiveTab = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  useActions: () => ({ set_active_tab: setActiveTab }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }) => children,
}));

it("restores a transparent background after leaving a navigation tab", () => {
  const { rerender } = render(
    <NavTab name="projects" label="Projects" active_top_tab="projects" />,
  );
  const button = screen.getByRole("button", { name: "Projects" });
  expect(button.style.backgroundColor).toBe(UI_COLORS.selected);
  expect(button).toHaveAttribute("aria-current", "page");
  rerender(<NavTab name="projects" label="Projects" active_top_tab="hosts" />);
  expect(button.style.backgroundColor).toBe("transparent");
  expect(button).not.toHaveAttribute("aria-current");
  fireEvent.click(button);
  expect(setActiveTab).toHaveBeenCalledWith("projects");
});

it("exposes only the selected application destination as the current page", () => {
  const tabs = (active: string) => (
    <>
      <NavTab name="agents" label="Agents" active_top_tab={active} />
      <NavTab name="projects" label="Projects" active_top_tab={active} />
      <NavTab name="hosts" label="Compute" active_top_tab={active} />
    </>
  );
  const { rerender } = render(tabs("agents"));
  expect(screen.getByRole("button", { current: "page" })).toHaveAccessibleName(
    "Agents",
  );
  rerender(tabs("hosts"));
  expect(screen.getByRole("button", { current: "page" })).toHaveAccessibleName(
    "Compute",
  );
  expect(screen.getByRole("button", { name: "Agents" })).not.toHaveAttribute(
    "aria-current",
  );
});

it("does not mark project tabs or unnamed action buttons as current pages", () => {
  render(
    <>
      <NavTab
        name="project-id"
        label="Project tab"
        active_top_tab="project-id"
        is_project
      />
      <NavTab label="Action" />
    </>,
  );
  expect(screen.queryByRole("button", { current: "page" })).toBeNull();
  expect(screen.getByRole("button", { name: "Project tab" })).toHaveAttribute(
    "data-node-key",
    "project-id",
  );
});
