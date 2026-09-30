import { expect, test, type Page } from "@playwright/test";

// First row intersecting the top of a chat's scroller.
async function readingPosition(page: Page, id: string) {
  return await page.evaluate((id) => {
    const scroller = document.querySelector<HTMLElement>(
      `[data-testid=log-${id}] [data-virtuoso-scroller]`,
    );
    if (!scroller) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const item of scroller.querySelectorAll<HTMLElement>(
      "[data-item-index]",
    )) {
      if (item.getBoundingClientRect().bottom > top + 1) {
        return {
          index: Number(item.getAttribute("data-item-index")),
          scrollTop: Math.round(scroller.scrollTop),
        };
      }
    }
    return { index: -1, scrollTop: Math.round(scroller.scrollTop) };
  }, id);
}

for (const reorder of [false, true]) {
  test(`returning to a retained chat keeps its reading position (${reorder ? "moved" : "stable"} DOM)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/?mode=chat-switch&reorder=${reorder ? 1 : 0}`);
    const a = page.getByTestId("log-a");
    await expect(a.locator("[data-item-index]").first()).toBeVisible();
    await page.waitForTimeout(1000);
    await a.hover();
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -2500);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(1500);
    const before = await readingPosition(page, "a");
    expect(before!.scrollTop).toBeGreaterThan(1000);

    await page.evaluate(() => (window as any).__chatSwitch("b"));
    await page.waitForTimeout(1000);
    await page.evaluate(() => (window as any).__chatSwitch("a"));
    await page.waitForTimeout(1500);

    const after = await readingPosition(page, "a");
    expect(Math.abs(after!.index - before!.index)).toBeLessThanOrEqual(1);
  });
}
