import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkEverythingRead } from "./mark-everything-read";

it("supports keyboard activation and keeps focus while marking all tiles read", async () => {
  const user = userEvent.setup();
  let resolve!: () => void;
  const onMarkRead = jest.fn(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  render(<MarkEverythingRead disabled={false} onMarkRead={onMarkRead} />);
  const button = screen.getByRole("button", { name: "Mark Everything Read" });
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onMarkRead).toHaveBeenCalledTimes(1);
  await user.keyboard("{Enter}");
  expect(onMarkRead).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(button).toHaveFocus();
});

it("disables bulk read when there are no unread notifications", () => {
  render(<MarkEverythingRead disabled onMarkRead={jest.fn()} />);
  expect(
    screen.getByRole("button", { name: "Mark Everything Read" }),
  ).toBeDisabled();
});
