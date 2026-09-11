import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewFileHeader, reviewFileHeaderHeight } from "./review-file-header";

test("historical opening and working-copy editing are distinct intents", async () => {
  const user = userEvent.setup();
  const copy = jest.fn(),
    view = jest.fn(),
    edit = jest.fn(),
    relative = jest.fn();
  render(
    <ReviewFileHeader
      path="new.ts"
      oldPath="old.ts"
      fontSize={18}
      onCopyPath={copy}
      onViewRevision={view}
      onEditWorking={edit}
      onCopyRelative={relative}
    />,
  );
  const path = screen.getByRole("button", {
    name: "Copy repository-relative path: new.ts (renamed from old.ts)",
  });
  expect(path.textContent).toContain("old.ts");
  path.focus();
  await user.keyboard("{Enter}");
  expect(copy).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "View at this revision" }),
  );
  expect(view).toHaveBeenCalledTimes(1);
  expect(edit).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "More file actions: new.ts" }),
  );
  await user.click(await screen.findByText("Edit in this worktree"));
  expect(edit).toHaveBeenCalledTimes(1);
});

test("selecting path text suppresses copy activation and long paths remain contained", () => {
  const copy = jest.fn();
  const path = "directory/".repeat(30) + "file.ts";
  render(<ReviewFileHeader path={path} fontSize={20} onCopyPath={copy} />);
  const button = screen.getByRole("button", {
    name: `Copy repository-relative path: ${path}`,
  });
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(button);
  selection.addRange(range);
  fireEvent.click(button);
  expect(copy).not.toHaveBeenCalled();
  selection.removeAllRanges();
  fireEvent.click(button);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(button.style.textOverflow).toBe("ellipsis");
  expect(button.parentElement!.style.height).toBe(
    `${reviewFileHeaderHeight(20)}px`,
  );
  expect(reviewFileHeaderHeight(14)).toBe(37);
  expect(button.parentElement).toHaveStyle({
    display: "flex",
    alignItems: "center",
  });
  expect(button.style.flex).toBe("1 1 0%");
});

test("unavailable historical opening never falls back to working-copy opening", () => {
  render(
    <ReviewFileHeader
      path="gone.ts"
      fontSize={14}
      onCopyPath={() => {}}
      onEditWorking={() => {}}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Open", exact: true }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "View at this revision" }),
  ).toBeNull();
});

test("the previous revision is a separate keyboard-accessible action", async () => {
  const user = userEvent.setup();
  const before = jest.fn();
  const after = jest.fn();
  render(
    <ReviewFileHeader
      path="renamed.md"
      oldPath="original.md"
      fontSize={14}
      onCopyPath={() => {}}
      onViewRevision={after}
      onViewBefore={before}
    />,
  );
  screen.getByRole("button", { name: "More file actions: renamed.md" }).focus();
  await user.keyboard("{Enter}");
  const item = await screen.findByRole("menuitem", {
    name: "View before this change",
  });
  item.focus();
  expect(item).toHaveFocus();
  // rc-menu reads the native keyCode, which user-event does not supply.
  expect(
    fireEvent.keyDown(item, { key: "Enter", code: "Enter", keyCode: 13 }),
  ).toBe(false);
  expect(before).toHaveBeenCalledTimes(1);
  expect(after).not.toHaveBeenCalled();
});
