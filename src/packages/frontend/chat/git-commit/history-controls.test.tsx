import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHistoryControls } from "./history-controls";
import { resolveHistorySelection } from "@cocalc/frontend/git/history-selection";

jest.mock("@cocalc/frontend/git/project-read-service", () => ({
  projectGitReader: {},
}));
jest.mock("@cocalc/frontend/git/history-selection", () => ({
  resolveHistorySelection: jest.fn(),
}));
const origin = {
  repository: {
    projectId: "p",
    locator: "/repo",
    commonDirectory: "/repo/.git",
    objectFormat: "sha1" as const,
  },
  worktrees: [
    { path: "/repo", detached: false, bare: false, branch: "refs/heads/main" },
    {
      path: "/feature",
      detached: false,
      bare: false,
      branch: "refs/heads/feature",
    },
  ],
  refs: [
    { name: "refs/heads/main", object: "a".repeat(40) },
    { name: "refs/heads/feature", object: "b".repeat(40) },
  ],
};
const selection = { worktree: "/repo", ref: "HEAD", firstParent: true };

test("merge visibility changes immediately by keyboard without browsing a new ref", async () => {
  const user = userEvent.setup();
  const onApply = jest.fn();
  const onShowMergesChange = jest.fn();
  const props = {
    origin,
    selection,
    disabled: false,
    onApply,
    onShowMergesChange,
  };
  const { rerender } = render(
    <GitHistoryControls {...props} showMerges={false} />,
  );
  const checkbox = screen.getByRole("checkbox", { name: "Show merge commits" });
  expect(checkbox).not.toBeChecked();
  checkbox.focus();
  await user.keyboard(" ");
  expect(onShowMergesChange).toHaveBeenLastCalledWith(true);
  expect(onApply).not.toHaveBeenCalled();
  rerender(<GitHistoryControls {...props} showMerges />);
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveFocus();
  await user.keyboard(" ");
  expect(onShowMergesChange).toHaveBeenLastCalledWith(false);
});

test("keyboard browsing applies the validated choice, not each draft change", async () => {
  const user = userEvent.setup();
  const onApply = jest.fn();
  jest
    .mocked(resolveHistorySelection)
    .mockResolvedValue({ discovery: origin, tip: "b".repeat(40) });
  render(
    <GitHistoryControls
      origin={origin}
      selection={selection}
      disabled={false}
      onApply={onApply}
    />,
  );
  await user.type(
    screen.getByRole("combobox", { name: "Review working copy" }),
    "/feature",
  );
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Review working copy" }),
    { key: "Enter", keyCode: 13, which: 13 },
  );
  await user.type(
    screen.getByRole("combobox", { name: "History ref" }),
    "heads/feature",
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "History ref" }), {
    key: "Enter",
    keyCode: 13,
    which: 13,
  });
  expect(onApply).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Browse / Refresh" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(onApply).toHaveBeenCalledWith(
      { worktree: "/feature", ref: "refs/heads/feature", firstParent: true },
      origin,
      "b".repeat(40),
    ),
  );
});

test("late results from an obsolete context do not replace the new review", async () => {
  let finish!: (value: any) => void;
  jest.mocked(resolveHistorySelection).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onApply = jest.fn();
  const { rerender } = render(
    <GitHistoryControls
      origin={origin}
      selection={selection}
      disabled={false}
      onApply={onApply}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Browse / Refresh" }),
  );
  rerender(
    <GitHistoryControls
      origin={origin}
      selection={{ ...selection, ref: "refs/heads/main" }}
      disabled={false}
      onApply={onApply}
    />,
  );
  finish({ discovery: origin, tip: "b".repeat(40) });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Browse / Refresh" }),
    ).not.toHaveAttribute("disabled"),
  );
  expect(onApply).not.toHaveBeenCalled();
});
