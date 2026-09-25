import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TransferButton from "./transfer-button";

jest.mock("./credit-transfers", () => ({
  __esModule: true,
  default: () => <input aria-label="Recipient" />,
}));

it("keeps the form behind a keyboard-operable button and restores focus", async () => {
  const user = userEvent.setup();
  render(<TransferButton />);
  expect(screen.queryByRole("textbox", { name: "Recipient" })).toBeNull();
  const button = screen.getByRole("button", { name: "Transfer", exact: true });
  button.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("textbox", { name: "Recipient" }),
  ).toBeInTheDocument();
  await user.click(
    screen.getAllByRole("button", { name: "Close", exact: true }).at(-1)!,
  );
  await waitFor(() => expect(button).toHaveFocus());
});
