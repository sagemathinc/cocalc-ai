import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FreshConversationModal } from "./fresh-conversation-modal";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => undefined },
}));

test("keyboard confirmation keeps errors visible and permits an explicit retry", async () => {
  const user = userEvent.setup();
  const onConfirm = jest
    .fn()
    .mockRejectedValueOnce(new Error("Finish queued work"))
    .mockResolvedValue(undefined);
  const onClose = jest.fn();
  render(
    <FreshConversationModal
      name="helper"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  expect(
    screen.getByRole("dialog", {
      name: "Start a fresh conversation with @helper?",
    }),
  ).toBeTruthy();
  const button = screen.getByRole("button", {
    name: "Start fresh conversation",
  });
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Finish queued work",
    ),
  );
  expect(onClose).not.toHaveBeenCalled();
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onConfirm).toHaveBeenCalledTimes(2);
});

test("Escape cancels without creating a conversation", async () => {
  const user = userEvent.setup();
  const onConfirm = jest.fn(),
    onClose = jest.fn();
  render(
    <FreshConversationModal
      name="helper"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  screen.getByRole("button", { name: "Cancel" }).focus();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});
