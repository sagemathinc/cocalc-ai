import assert from "node:assert/strict";

// Run against a chat with a visible message action bar. Does not edit or send.
export async function checkMessageFocus(page) {
  const trigger = page
    .getByRole("button", { name: "Focus this message", exact: true })
    .first();
  const row = await trigger.evaluateHandle((element) =>
    element.closest('.ant-row[tabindex="-1"]'),
  );
  try {
    for (const closeMethod of ["escape", "button"]) {
      await row.asElement().hover();
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
      }));
      assert(bounds && viewport);
      assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1);
      if (closeMethod === "escape") {
        await page.keyboard.press("Escape");
      } else {
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
      }
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(
        (source) =>
          source === document.activeElement ||
          (source?.contains(document.activeElement) &&
            document.activeElement?.getAttribute("aria-label") ===
              "Focus this message"),
        row,
      );
    }
  } finally {
    await row.dispose();
  }
}
