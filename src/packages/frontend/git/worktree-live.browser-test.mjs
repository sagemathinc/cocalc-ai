// Live drawer acceptance with disposable detached worktrees. Load the matching
// CoCalc CLI environment first. No user branch, index, or checkout is changed.
// node .../worktree-live.browser-test.mjs <chat-url> <repository-path>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { checkWorktreeAgent } from "./worktree-agent-live.mjs";
import {
  chooseHistory,
  historySelect,
} from "./history-select.browser-helper.mjs";
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
let agentMayBeRunning = false;
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
  async function open(working = false, explicitWorktree = false) {
    await page?.close();
    page = await browser.contexts()[0].newPage();
    page.setDefaultTimeout(30000);
    const staleBuild = page.getByRole("button", {
      name: "Dismiss stale frontend build warning",
    });
    await page.addLocatorHandler(staleBuild, () => staleBuild.click());
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.bringToFront();
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    for (const key of [...target.searchParams.keys()])
      if (key.startsWith("git-")) target.searchParams.delete(key);
    target.searchParams.set("git-hash", working ? "HEAD" : commit);
    if (working || explicitWorktree) {
      target.searchParams.set("git-cwd", first);
      target.searchParams.set("git-tip", commit);
    }
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("combobox", { name: "Review working copy", exact: true }),
    ).toBeVisible({ timeout: 60000 });
    const warning = page.getByRole("button", {
      name: "Dismiss stale frontend build warning",
    });
    if (await warning.isVisible()) await warning.click();
  }
  add(first);
  await open();
  await expect(historySelect(page, "Review working copy")).toContainText(
    first,
    { timeout: 60000 },
  );
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
  await expect(
    page.getByRole("region", { name: "Git diff", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("combobox", { name: "Diff renderer", exact: true }),
  ).toHaveCount(0);
  const header = page.locator(
    `[data-review-file-header=${JSON.stringify(file)}]`,
  );
  await header.getByRole("button", { name: "Open", exact: true }).click();
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/projects/${project}/files${first}/${file}`);
  await open(false, true);
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption({ label: file });
  await page
    .getByRole("region", { name: "Git diff", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page
    .locator(`[data-review-file-header=${JSON.stringify(file)}]`)
    .getByRole("button", { name: `More file actions: ${file}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit in this worktree", exact: true })
    .click();
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/projects/${project}/files${first}/${file}`);
  await open(true);
  if (process.env.REVIEW_AGENT === "1") {
    await open(false, true);
    const run = await checkWorktreeAgent({
      page,
      project,
      chatPath: decodeURIComponent(url.pathname.split("/files")[1]),
      worktree: first,
      expect,
      onDispatch: () => {
        agentMayBeRunning = true;
      },
    });
    let activity;
    await expect
      .poll(
        () => {
          activity = run.activity();
          return activity.events?.some(
            (event) => event.type === "summary" || event.type === "error",
          );
        },
        { timeout: 180000, intervals: [3000] },
      )
      .toBe(true);
    agentMayBeRunning = false;
    const error = activity.events.find((event) => event.type === "error");
    assert(!error, `Agent terminated without acceptance: ${error?.error}`);
    assert.equal(
      activity.events.find((e) => e.event?.type === "config")?.event
        .workingDirectory,
      first,
    );
    assert(
      activity.events
        .find((e) => e.type === "summary")
        ?.finalResponse.includes(first),
    );
    assert(
      activity.events.some(
        (e) =>
          e.event?.type === "terminal" &&
          e.event.cwd === first &&
          e.event.exitStatus?.exitCode === 0 &&
          e.event.output?.split(/\r?\n/).includes(first) &&
          activity.events.some(
            (start) =>
              start.event?.type === "terminal" &&
              start.event.terminalId === e.event.terminalId &&
              start.event.phase === "start" &&
              /\bpwd\b/.test(start.event.command ?? ""),
          ),
      ),
      "A successful terminal pwd result must confirm the actual execution directory",
    );
    console.log("Completed worktree agent activity", JSON.stringify(activity));
  }
  add(second);
  await open();
  await expect(
    page.getByText("Several worktrees contain this commit:", { exact: false }),
  ).toBeVisible({ timeout: 60000 });
  await expect(historySelect(page, "Review working copy")).toContainText(
    repository,
  );
  remove(second);
  remove(first);
  await open();
  await expect(
    page.getByText("No available worktree contains this commit.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 60000 });
  assert.equal(new URL(page.url()).searchParams.get("git-hash"), commit);
  await chooseHistory(page, "Branch / ref", testRef);
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
  await expect(historySelect(page, "Branch / ref")).toContainText(
    testRef.replace(/^refs\/(heads|remotes)\//, ""),
    { timeout: 60000 },
  );
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
    `Passed: unique detached worktree auto-selection and exact working-file opening in Pierre; ambiguous/absent notices; moved ref stays pinned across reload until explicit refresh. Agent check: ${process.env.REVIEW_AGENT === "1" ? "completed" : "not requested"}.`,
  );
} finally {
  await page?.close();
  if (agentMayBeRunning) {
    console.error(
      `Agent completion unverified; preserve fixture ${root} and ${testRef} until the submitted turn is terminal.`,
    );
  } else {
    for (const path of registered)
      remote(`git worktree remove --force ${quote(path)}`);
    if (refTip) remote(`git update-ref -d ${quote(testRef)} ${refTip}`);
    remote(`rmdir ${quote(root)}`);
    assert.equal(remote("git worktree list --porcelain"), before);
  }
}
// Disconnect without closing the maintainer's browser.
process.exit(0);
