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
  rerender(<NavTab name="projects" label="Projects" active_top_tab="hosts" />);
  expect(button.style.backgroundColor).toBe("transparent");
  fireEvent.click(button);
  expect(setActiveTab).toHaveBeenCalledWith("projects");
});
