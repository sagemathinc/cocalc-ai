import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CopyButton from "./copy-button";
import { copyTextToClipboard } from "./copy-to-clipboard-util";

jest.mock("./copy-to-clipboard-util", () => ({
  copyTextToClipboard: jest.fn(async () => true),
}));

test("large exports are materialized only when the user copies them", async () => {
  const value = jest.fn(() => "complete activity");
  const { rerender } = render(<CopyButton value={value} markdown />);
  rerender(<CopyButton value={value} markdown size="small" />);
  expect(value).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy(),
  );
  expect(value).toHaveBeenCalledTimes(1);
  expect(copyTextToClipboard).toHaveBeenCalledWith({
    text: "complete activity",
    markdown: true,
  });
});
