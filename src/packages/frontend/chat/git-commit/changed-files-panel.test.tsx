import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitChangedFilesPanel } from "./drawer-sections";

test("file selection requests an immediate jump through unmeasured files", async () => {
  const user = userEvent.setup();
  const navigate = jest.fn();
  render(
    <GitChangedFilesPanel
      files={[
        { path: "first.ts", lines: [] },
        { path: "deleted.md", lines: [] },
      ]}
      inlineCommentsByFile={new Map()}
      onOpenFileDiff={navigate}
    />,
  );
  const select = screen.getByRole("combobox", { name: "Changed files" });
  select.focus();
  await user.selectOptions(select, "1");
  expect(navigate).toHaveBeenCalledWith(1, "auto");
  expect(select).toHaveFocus();
});
