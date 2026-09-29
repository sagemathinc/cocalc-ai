import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const transfer = jest.fn();
const fresh = jest.fn(async (action) => {
  await action();
  return true;
});
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      client: { browser_id: "browser" },
      hub: {
        projects: { transferProjectOwnership: (...args) => transfer(...args) },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: fresh,
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ set_active_key_handler: jest.fn() }) },
}));
import { TransferOwnership } from "./transfer-ownership";
const props = {
  project_id: "project",
  owner_account_id: "owner",
  collaborators: [{ account_id: "recipient", name: "Example Collaborator" }],
};
beforeEach(() => {
  jest.clearAllMocks();
  transfer.mockResolvedValue({});
});

it("opens by keyboard, cancels with Escape, and restores trigger focus", async () => {
  const user = userEvent.setup();
  render(<TransferOwnership {...props} />);
  const trigger = screen.getByRole("button", { name: "Transfer ownership" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Transfer project ownership",
  });
  expect(
    within(dialog).getByRole("combobox", { name: "New owner" }),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Confirm ownership transfer" }),
  ).toBeDisabled();
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(transfer).not.toHaveBeenCalled();
});

it("selects a collaborator with the keyboard and submits only after explicit confirmation", async () => {
  const user = userEvent.setup();
  render(<TransferOwnership {...props} />);
  await user.click(screen.getByRole("button", { name: "Transfer ownership" }));
  const combo = screen.getByRole("combobox", { name: "New owner" });
  combo.focus();
  // rc-select uses legacy keyCode; user-event does not populate it in JSDOM.
  fireEvent.keyDown(combo, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(combo, { key: "Enter", keyCode: 13 });
  expect(transfer).not.toHaveBeenCalled();
  const confirm = screen.getByRole("button", {
    name: "Confirm ownership transfer",
  });
  await waitFor(() => expect(confirm).not.toBeDisabled());
  confirm.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(transfer).toHaveBeenCalledWith({
      project_id: "project",
      from_account_id: "owner",
      to_account_id: "recipient",
      browser_id: "browser",
    }),
  );
  expect(fresh).toHaveBeenCalledTimes(1);
});

it("exposes server errors without silently closing the confirmation", async () => {
  transfer.mockRejectedValue(new Error("project limit reached"));
  render(<TransferOwnership {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  const combo = screen.getByRole("combobox", { name: "New owner" });
  fireEvent.keyDown(combo, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(combo, { key: "Enter", keyCode: 13 });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm ownership transfer" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("alert", { name: "Ownership transfer failed" })
        .textContent,
    ).toContain("project limit reached"),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});
