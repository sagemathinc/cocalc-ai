// Run against an explicitly supplied chat URL and commit in a signed-in,
// isolated CDP browser. Creates and closes only its own test tab.
// node .../review-route.browser-test.mjs <chat-url> <commit>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");

const [chatUrl, commit] = process.argv.slice(2);
if (!chatUrl || !/^[a-f0-9]{7,64}$/i.test(commit ?? "")) {
  throw Error("Supply a chat URL and a commit present in its repository.");
}
const url = new URL(chatUrl);
url.searchParams.set("git-hash", commit);
url.searchParams.set("review-test", "preserved");
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const preview = page.getByRole("region", {
    name: "Git diff",
    exact: true,
  });
  await expect(preview).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByRole("combobox", { name: "Diff renderer", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview with Pierre", exact: true }),
  ).toHaveCount(0);
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  if (await warning.isVisible()) await warning.click();
  expect(new URL(page.url()).searchParams.get("git-hash")).toBe(commit);
  await expect(
    page.getByText(
      "A review URL does not select an agent or change its working directory.",
      { exact: false },
    ),
  ).toBeVisible();

  const older = page.getByRole("button", { name: "Older", exact: true });
  await expect(older).toBeEnabled();
  await older.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-hash"))
    .not.toBe(commit);
  const selected = new URL(page.url()).searchParams.get("git-hash");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(preview).toBeVisible({ timeout: 60000 });
  expect(new URL(page.url()).searchParams.get("git-hash")).toBe(selected);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("git-hash")).toBe(false);
  expect(new URL(page.url()).searchParams.get("review-test")).toBe("preserved");
  await page
    .getByRole("button", { name: "Open git browser", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30000 });
  expect(new URL(page.url()).searchParams.has("git-hash")).toBe(false);
  await page.goForward();
  await expect(page.getByRole("dialog")).toHaveCount(1, { timeout: 30000 });
  expect(new URL(page.url()).searchParams.has("git-hash")).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "Passed: deep link, selected commit, reload, Escape, Back/Forward, unrelated parameters, and no page errors.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.close();
  // Do not close the maintainer's browser or other tabs.
  process.exit(process.exitCode ?? 0);
}
