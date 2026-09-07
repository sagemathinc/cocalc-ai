// Disposable full-hash/abbreviated draft fixture. Leaves only account choice
// metadata; removes its unchanged browser drafts, never unrelated review data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chat, hash, account] = process.argv.slice(2);
assert(/^[a-f0-9]{40,64}$/.test(hash ?? ""));
assert(/^[a-f0-9-]{36}$/.test(account ?? ""));
const short = hash.slice(0, 12);
const url = new URL(chat);
for (const key of [...url.searchParams.keys()])
  if (key.startsWith("git-")) url.searchParams.delete(key);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const prefix = `cocalc:git-review:draft:v2:account:${account}:commit:`;
const expected = {};
try {
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "Open git browser", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  for (const id of [short, hash]) {
    const key = prefix + id;
    const value = JSON.stringify({
      reviewed: false,
      note: `Alias acceptance ${id}`,
      comments: {},
      updated_at: Date.now(),
      revision: 1,
    });
    await page.evaluate(
      ({ key, value }) => {
        if (localStorage.getItem(key) !== null)
          throw Error("Fixture draft already exists");
        localStorage.setItem(key, value);
      },
      { key, value },
    );
    expected[key] = value;
  }
  url.searchParams.set("git-hash", hash);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const conflict = page.getByText(
    "Multiple saved reviews refer to this commit",
    { exact: true },
  );
  await expect(conflict).toBeVisible({ timeout: 60000 });
  await page
    .getByRole("radio", { name: `Use review ${hash}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Use selected review", exact: true })
    .press("Enter");
  await expect(conflict).toHaveCount(0);
  await expect(
    page.getByText(`Alias acceptance ${hash}`, { exact: true }),
  ).toBeVisible();
  const readDrafts = () =>
    page.evaluate(
      (keys) =>
        Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
      Object.keys(expected),
    );
  assert.deepEqual(await readDrafts(), expected);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText(`Alias acceptance ${hash}`, { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(conflict).toHaveCount(0);
  assert.deepEqual(await readDrafts(), expected);
  const changed = JSON.stringify({
    ...JSON.parse(expected[prefix + short]),
    note: "Alias acceptance changed alternative",
    revision: 2,
    updated_at: Date.now(),
  });
  await page.evaluate(
    ({ key, before, changed }) => {
      if (localStorage.getItem(key) !== before)
        throw Error("Fixture changed concurrently");
      localStorage.setItem(key, changed);
    },
    { key: prefix + short, before: expected[prefix + short], changed },
  );
  expected[prefix + short] = changed;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(conflict).toBeVisible({ timeout: 60000 });
  await page
    .getByRole("radio", { name: `Use review ${short}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Use selected review", exact: true })
    .press("Enter");
  await expect(conflict).toHaveCount(0);
  await expect(
    page.getByText("Alias acceptance changed alternative", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(await readDrafts(), expected);
  console.log(
    "Passed: explicit alias choice persists across reload; changing the unselected draft reopens conflict; switching active alias preserves both drafts byte-for-byte.",
  );
} finally {
  await page.evaluate((expected) => {
    for (const [key, value] of Object.entries(expected)) {
      if (localStorage.getItem(key) === value) localStorage.removeItem(key);
    }
  }, expected);
  await page.close();
}
process.exit(0);
