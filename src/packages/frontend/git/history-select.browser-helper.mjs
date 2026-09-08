export function historySelect(page, name) {
  return page.locator(".ant-select").filter({
    has: page.getByRole("combobox", { name, exact: true }),
  });
}

export async function chooseHistory(page, name, value) {
  const input = page.getByRole("combobox", { name, exact: true });
  await input.fill(
    value === "HEAD" ? "Selected worktree HEAD" : value.replace(/^refs\//, ""),
  );
  await input.press("ArrowDown");
  await input.press("Enter");
}
