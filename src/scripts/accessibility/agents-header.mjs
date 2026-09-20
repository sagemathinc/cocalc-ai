import assert from "node:assert/strict";

// Run against an open agent. Does not submit a turn or change its settings.
export async function checkAgentsHeader(page) {
  const trigger = page.getByRole("button", {
    name: "More navigation",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "Open terminal", exact: true })
    .waitFor();
  await page
    .getByRole("menuitem", { name: "Find in conversation", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "More navigation",
  );

  const directory = page.getByRole("button", {
    name: /^Change working directory:/,
  });
  await directory.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Working directory",
    exact: true,
  });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.activeElement
      ?.getAttribute("aria-label")
      ?.startsWith("Change working directory:"),
  );
  const bounds = await directory.boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  assert(
    bounds &&
      bounds.width > 0 &&
      bounds.x >= 0 &&
      bounds.x + bounds.width <= width,
  );
}
