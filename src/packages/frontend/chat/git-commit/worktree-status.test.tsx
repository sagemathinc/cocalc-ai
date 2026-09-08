import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorktreeStatus } from "./worktree-status";

test("reserves the same slot before, during, and after discovery", () => {
  const view = render(<WorktreeStatus />);
  const slot = screen.getByRole("status", { name: "Worktree status" });
  const dimensions = slot.getAttribute("style");
  expect(slot).toHaveStyle({ width: "126px", height: "24px" });
  expect(screen.getByText("Locating worktree")).not.toBeVisible();
  view.rerender(
    <WorktreeStatus
      notice={{ locating: true, message: "Locating a worktree" }}
    />,
  );
  expect(screen.getByText("Locating worktree")).toBeVisible();
  expect(slot.getAttribute("style")).toBe(dimensions);
  view.rerender(
    <WorktreeStatus
      notice={{ locating: false, message: "Several worktrees match" }}
    />,
  );
  expect(screen.getByText("Historical view")).toBeVisible();
  expect(slot.getAttribute("style")).toBe(dimensions);
  view.rerender(<WorktreeStatus />);
  expect(screen.getByRole("status", { name: "Worktree status" })).toBe(slot);
  expect(slot.getAttribute("style")).toBe(dimensions);
  expect(screen.getByText("Locating worktree")).not.toBeVisible();
});

test("details are available by keyboard and dismissible with Escape", async () => {
  const user = userEvent.setup();
  render(
    <WorktreeStatus
      notice={{
        locating: false,
        message: "Several worktrees match; choose a working copy explicitly.",
      }}
    />,
  );
  await user.tab();
  expect(screen.getByText("Historical view").parentElement).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "choose a working copy explicitly",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
});
