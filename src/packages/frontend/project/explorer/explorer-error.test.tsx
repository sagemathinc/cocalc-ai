import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExplorerError } from "./explorer-error";

test("reserves panel-toggle space and allows keyboard dismissal", async () => {
  const user = userEvent.setup();
  const onClose = jest.fn();
  const { container } = render(
    <ExplorerError error="Error deleting 12 files" onClose={onClose} />,
  );
  const alert = screen.getByRole("alert");
  expect(container.firstChild).toHaveStyle({ paddingRight: "48px" });
  expect(alert.style.position).toBe("");
  expect(alert).toHaveTextContent("Error deleting 12 files");
  const close = screen.getByRole("button", { name: /close/i });
  await user.tab();
  expect(close).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("bounds long errors and wraps unbroken messages", () => {
  render(<ExplorerError error={"x".repeat(1000)} onClose={() => {}} />);
  expect(screen.getByRole("alert")).toHaveStyle({
    maxHeight: "150px",
    overflowY: "auto",
  });
  expect(screen.getByText("x".repeat(1000)).parentElement).toHaveStyle({
    overflowWrap: "anywhere",
  });
});
