// Optional real-agent acceptance for the disposable worktree browser fixture.
// Leaves an audit thread and submitted comment; never asks the agent to edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

export async function checkWorktreeAgent({
  page,
  project,
  chatPath,
  worktree,
  expect,
  onDispatch,
}) {
  function cli(command, args = []) {
    const result = JSON.parse(
      execFileSync(
        "/opt/cocalc/bin/node",
        [
          "/opt/cocalc/bin2/cocalc-cli.js",
          "--json",
          "project",
          "chat",
          ...command,
          "-w",
          project,
          "--path",
          chatPath,
          ...args,
        ],
        { encoding: "utf8", timeout: 90000 },
      ),
    );
    assert(result.ok, JSON.stringify(result));
    return result.data;
  }
  const before = new Set(
    cli(["thread", "status"]).threads.map((t) => t.thread_id),
  );
  // URL browsing deliberately does not bind an agent. Enter through the chat's
  // Git action so the production callback carries the selected thread context.
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Open git browser", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Review working copy", exact: true })
    .selectOption(worktree);
  await page
    .getByRole("button", { name: "Browse / Refresh", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-cwd"))
    .toBe(worktree);
  await expect(
    page.getByRole("checkbox", {
      name: `Send agent feedback in ${worktree}`,
      exact: false,
    }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByText("Loading review state...", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Git diff", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption({ index: 1 });
  await page
    .locator("diffs-container [data-gutter] [data-line-number-content]")
    .first()
    .click();
  await page
    .getByRole("button", { name: "Add inline comment", exact: true })
    .click();
  const editor = page.locator(
    '[aria-label="Active inline comment"] [contenteditable="true"]',
  );
  await expect(editor).toBeVisible();
  await editor.evaluate((element) => {
    let fiber =
      element[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))
      ];
    while (fiber && !fiber.memoizedProps?.editor?.insertText)
      fiber = fiber.return;
    if (!fiber) throw Error("Slate instance missing");
    const slate = fiber.memoizedProps.editor;
    slate.select({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    slate.insertText(
      "Acceptance test only: do not edit, commit, or modify any files. Run pwd and report its exact output, then finish. This comment tests review feedback routing, not a requested code change.",
    );
  });
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: `Send agent feedback in ${worktree}`,
      exact: false,
    })
    .check();
  const submit = page.getByRole("button", {
    name: /^Send inline comments to agent/,
  });
  await expect(submit).toBeEnabled();
  onDispatch();
  await submit.click();
  let thread;
  await expect
    .poll(
      () => {
        thread = cli(["thread", "status"]).threads.find(
          (t) =>
            !before.has(t.thread_id) &&
            t.acp_config?.workingDirectory === worktree,
        );
        return thread?.thread_id;
      },
      { timeout: 120000, intervals: [2000] },
    )
    .toBeTruthy();
  assert.equal(thread.agent_kind, "acp");
  console.log(
    "Created worktree feedback thread",
    thread.thread_id,
    JSON.stringify(thread.acp_config),
  );
  return {
    threadId: thread.thread_id,
    activity: () => cli(["activity"], ["--thread-id", thread.thread_id]),
  };
}
