// Live drawer acceptance with disposable detached worktrees. Load the matching
// CoCalc CLI environment first. No user branch, index, or checkout is changed.
// node .../worktree-live.browser-test.mjs <chat-url> <repository-path>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chat, repository] = process.argv.slice(2);
const url = new URL(chat);
const project = url.pathname.match(/\/projects\/([^/]+)\/files\//)?.[1];
assert(project && repository?.startsWith("/"));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function remote(command) {
  const result = JSON.parse(
    execFileSync(
      "/opt/cocalc/bin/node",
      [
        "/opt/cocalc/bin2/cocalc-cli.js",
        "--json",
        "project",
        "exec",
        "-w",
        project,
        "--path",
        repository,
        "--bash",
        command,
      ],
      { encoding: "utf8", timeout: 90000 },
    ),
  );
  assert.equal(result.data?.exit_code, 0, JSON.stringify(result));
  return result.data.stdout.trim();
}
const before = remote("git worktree list --porcelain");
const root = remote("mktemp -d /tmp/cocalc-review-worktrees-XXXXXX");
assert(/^\/tmp\/cocalc-review-worktrees-[A-Za-z0-9]+$/.test(root));
const registered = new Set();
const testRef = `refs/heads/${root.split("/").at(-1)}`;
let refTip;
let page;
try {
  const commit = remote(
    "git -c user.name=CoCalcReviewSmoke -c user.email=review-smoke@example.invalid commit-tree HEAD^{tree} -p HEAD^ -m 'Disposable worktree review acceptance'",
  );
  assert(/^[a-f0-9]{40,64}$/.test(commit));
  remote(
    `git update-ref ${quote(testRef)} ${commit} ${"0".repeat(commit.length)}`,
  );
  refTip = commit;
  const first = `${root}/first`,
    second = `${root}/second`;
  function add(path) {
    remote(`git worktree add --detach --no-checkout ${quote(path)} ${commit}`);
    registered.add(path);
  }
  function remove(path) {
    // --no-checkout deliberately leaves the disposable index unpopulated.
    remote(`git worktree remove --force ${quote(path)}`);
    registered.delete(path);
  }
  const browser = await chromium.connectOverCDP(
    process.env.CDP_URL ?? "http://localhost:9222",
  );
  const errors = [];
  async function open(working = false) {
    await page?.close();
    page = await browser.contexts()[0].newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    for (const key of [...target.searchParams.keys()])
      if (key.startsWith("git-")) target.searchParams.delete(key);
    target.searchParams.set("git-hash", working ? "HEAD" : commit);
    if (working) {
      target.searchParams.set("git-cwd", first);
      target.searchParams.set("git-tip", commit);
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("combobox", { name: "Review working copy", exact: true }),
    ).toBeVisible({ timeout: 60000 });
  }
  add(first);
  await open();
  await expect(
    page.getByRole("combobox", { name: "Review working copy", exact: true }),
  ).toHaveValue(first, { timeout: 60000 });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-tip"))
    .toBe(commit);
  assert.equal(new URL(page.url()).searchParams.get("git-cwd"), first);
  const file = remote(
    `git diff-tree --no-commit-id --name-only -r --diff-filter=AM ${commit}`,
  )
    .split("\n")
    .find((path) => /^[a-zA-Z0-9_./-]+\.(md|tsx?|json)$/.test(path));
  assert(file, "Fixture must have a changed text file");
  remote(
    `git -C ${quote(first)} restore --source=${commit} --worktree -- ${quote(file)}`,
  );
  remote(`git -C ${quote(first)} read-tree ${commit}`);
  remote(
    `git -C ${quote(first)} ls-files -z | git -C ${quote(first)} update-index --skip-worktree -z --stdin`,
  );
  remote(
    `git -C ${quote(first)} update-index --no-skip-worktree -- ${quote(file)}`,
  );
  remote(
    `printf '\\nDisposable working-copy acceptance marker\\n' >> ${quote(`${first}/${file}`)}`,
  );
  await open(true);
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption({ label: file });
  const renderer = () =>
    page.getByRole("combobox", { name: "Diff renderer", exact: true });
  const previousRenderer = await renderer().inputValue();
  try {
    for (const mode of ["legacy", "pierre"]) {
      await renderer().selectOption(mode);
      await page
        .getByRole("combobox", { name: "Changed files", exact: true })
        .selectOption({ label: file });
      const header =
        mode === "legacy"
          ? page.locator('[data-git-diff-section="true"]').filter({
              has: page.getByRole("button", { name: file, exact: true }),
            })
          : page.locator(`[data-review-file-header=${JSON.stringify(file)}]`);
      await header.getByRole("button", { name: "Open", exact: true }).click();
      await expect
        .poll(() => decodeURIComponent(new URL(page.url()).pathname))
        .toBe(`/projects/${project}/files${first}/${file}`);
      await open(true);
    }
  } finally {
    await renderer().selectOption(previousRenderer);
  }
  add(second);
  await open();
  await expect(
    page.getByText("Several worktrees contain this commit:", { exact: false }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("combobox", { name: "Review working copy", exact: true }),
  ).toHaveValue(repository);
  remove(second);
  remove(first);
  await open();
  await expect(
    page.getByText("No available worktree contains this commit.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 60000 });
  assert.equal(new URL(page.url()).searchParams.get("git-hash"), commit);
  await page
    .getByRole("combobox", { name: "History ref", exact: true })
    .selectOption(testRef);
  await page
    .getByRole("button", { name: "Browse / Refresh", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-tip"))
    .toBe(commit);
  const parent = remote(`git rev-parse ${commit}^`);
  remote(`git update-ref ${quote(testRef)} ${parent} ${commit}`);
  refTip = parent;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("combobox", { name: "History ref", exact: true }),
  ).toHaveValue(testRef, { timeout: 60000 });
  assert.equal(new URL(page.url()).searchParams.get("git-tip"), commit);
  assert.equal(new URL(page.url()).searchParams.get("git-hash"), commit);
  await page
    .getByRole("button", { name: "Browse / Refresh", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-tip"))
    .toBe(parent);
  assert.deepEqual(errors, []);
  console.log(
    "Passed: unique detached worktree auto-selection and exact working-file opening in both renderers; ambiguous/absent notices; moved ref stays pinned across reload until explicit refresh. No agent turn submitted.",
  );
} finally {
  await page?.close();
  for (const path of registered)
    remote(`git worktree remove --force ${quote(path)}`);
  if (refTip) remote(`git update-ref -d ${quote(testRef)} ${refTip}`);
  remote(`rmdir ${quote(root)}`);
  assert.equal(remote("git worktree list --porcelain"), before);
}
// Disconnect without closing the maintainer's browser.
process.exit(0);
