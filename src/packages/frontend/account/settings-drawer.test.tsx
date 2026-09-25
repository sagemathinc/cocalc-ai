import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsDrawer } from "./settings-drawer";
import { openAccountSettings } from "./settings-routing";
import { setSettingsDrawerOpen } from "./settings-drawer-state";
const setState = jest.fn();
const push = jest.fn();
const select = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
  redux: {
    getStore: () => ({ get: () => "agents" }),
    getActions: () => ({ setState, push_state: push, set_active_tab: select }),
  },
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("./settings-drawer-content", () => ({
  __esModule: true,
  default: () => <div>Shared settings components</div>,
}));
beforeEach(() => {
  setSettingsDrawerOpen(false);
  jest.clearAllMocks();
});
test("opens requested settings without changing Agents URL and restores focus on Escape", async () => {
  render(
    <>
      <button>Settings</button>
      <SettingsDrawer />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Settings" });
  trigger.focus();
  act(() => openAccountSettings({ page: "ai" }));
  expect(setState).toHaveBeenCalledWith({ active_page: "ai" });
  expect(push).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog", {
    name: "Account settings",
  });
  expect(await screen.findByText("Shared settings components")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape", keyCode: 27 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
test("direct settings routes retain full-page navigation", () => {
  openAccountSettings({ page: "profile" }, { changeHistory: false });
  expect(select).toHaveBeenCalledWith("account", false);
});
