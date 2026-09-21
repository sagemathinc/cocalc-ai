import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import Content from "./settings-drawer-content";
const navigate = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "ai",
}));
jest.mock("./settings-navigation", () => ({
  useSettingsNavigationContext: () => ({}),
  getVisibleSettingsNavigation: () => [
    { type: "page", page: "index" },
    { type: "group", pages: [{ page: "ai" }, { page: "profile" }] },
  ],
}));
jest.mock("./settings-page-registry", () => ({
  getRegisteredSettingsPageDefinition: (page) => ({
    label: { id: page, defaultMessage: page === "ai" ? "AI" : "Profile" },
    component: () => <div>Shared {page} settings</div>,
  }),
}));
jest.mock("./settings-routing", () => ({
  openAccountSettings: (...args) => navigate(...args),
}));
test("renders registered content with visible top tabs and no overview", () => {
  render(
    <IntlProvider locale="en">
      <Content />
    </IntlProvider>,
  );
  expect(screen.getByText("Shared ai settings")).toBeTruthy();
  expect(screen.queryByText("Shared profile settings")).toBeNull();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(
    screen.getByRole("combobox", { name: "Settings section" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Profile" }));
  expect(navigate).toHaveBeenCalledWith({ page: "profile" });
});
