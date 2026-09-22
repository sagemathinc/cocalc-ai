import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NotificationsDrawer } from "./drawer";
import { setNotificationsOpen } from "./drawer-state";

jest.mock("./ensure-init", () => ({
  ensureNotificationsInitialized: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./notification-page", () => ({
  NotificationPage: ({ embedded }) => (
    <div>{embedded ? "Embedded notifications" : "Full page"}</div>
  ),
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));

test("opens an accessible drawer, supports resize without dragging, and closes with Escape", async () => {
  render(
    <>
      <button>Open notifications</button>
      <NotificationsDrawer />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Open notifications" });
  trigger.focus();
  act(() => setNotificationsOpen(true));
  expect(
    await screen.findByRole("dialog", { name: "Notifications" }),
  ).toBeTruthy();
  expect(await screen.findByText("Embedded notifications")).toBeTruthy();
  const resize = screen.getByRole("button", { name: "Resize" });
  resize.focus();
  expect(document.activeElement).toBe(resize);
  fireEvent.click(resize);
  expect(localStorage.getItem("cocalc-notifications-drawer-width")).toBe("400");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", keyCode: 27 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
