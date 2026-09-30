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

for (const start of ["bottom", "middle"] as const) {
  test(`scrolling up while messages stream in is not undone (from the ${start})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/?mode=chat-switch&reorder=0`);
    const a = page.getByTestId("log-a");
    await expect(a.locator("[data-item-index]").first()).toBeVisible();
    await page.waitForTimeout(1000);
    await a.hover();
    if (start === "middle") {
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, -2500);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1500);
    }
    // An agent is working: new rows keep arriving.
    await page.evaluate(() => {
      (window as any).__chatStream = setInterval(
        () => (window as any).__chatAppend("a"),
        250,
      );
    });
    await page.waitForTimeout(800);
    // Scroll up a little, as a reader glancing back would.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);
    const scrolled = await readingPosition(page, "a");
    await page.waitForTimeout(2500);
    const later = await readingPosition(page, "a");
    await page.evaluate(() => clearInterval((window as any).__chatStream));
    expect(scrolled!.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(later!.index - scrolled!.index)).toBeLessThanOrEqual(1);
    expect(Math.abs(later!.scrollTop - scrolled!.scrollTop)).toBeLessThan(200);
  });
}

test("scrolling a long idle thread up and down is never pulled back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`/?mode=chat-switch&reorder=0`);
  const a = page.getByTestId("log-a");
  await expect(a.locator("[data-item-index]").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await a.hover();
  // Row indexes, not pixels: Virtuoso corrects scrollTop slightly as it
  // measures rows. Each step brings new rows into view.
  const row = async () => (await readingPosition(page, "a"))!.index;
  for (const delta of [-1500, 1500]) {
    const start = await row();
    let previous = start;
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(250);
      const now = await row();
      if (delta < 0) expect(now).toBeLessThanOrEqual(previous);
      else expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    if (delta < 0) expect(previous).toBeLessThan(start - 10);
    else expect(previous).toBeGreaterThan(start + 10);
    await page.waitForTimeout(1500);
    expect(Math.abs((await row()) - previous)).toBeLessThanOrEqual(1);
  }
});

async function gapFromBottom(page: Page, id: string) {
  return await page.evaluate((id) => {
    const s = document.querySelector<HTMLElement>(
      `[data-testid=log-${id}] [data-virtuoso-scroller]`,
    )!;
    return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight);
  }, id);
}

for (const resume of ["button", "wheel"] as const) {
  test(`after returning to the bottom via ${resume}, a streaming reply stays followed`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/?mode=chat-switch&reorder=0&chatMode=sidechat`);
    const a = page.getByTestId("log-a");
    await expect(a.locator("[data-item-index]").first()).toBeVisible();
    await page.waitForTimeout(1000);
    await a.hover();
    // A reply is streaming into the newest message.
    await page.evaluate(() => {
      (window as any).__chatStream = setInterval(
        () => (window as any).__chatGrow("a"),
        200,
      );
    });
    await page.waitForTimeout(1500);
    expect(await gapFromBottom(page, "a")).toBeLessThan(200);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    expect(await gapFromBottom(page, "a")).toBeGreaterThan(1000);
    if (resume === "button") {
      await page
        .getByRole("button", { name: "Scroll to newest messages" })
        .click();
    } else {
      for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(50);
      }
    }
    const gaps: number[] = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      gaps.push(await gapFromBottom(page, "a"));
    }
    await page.evaluate(() => clearInterval((window as any).__chatStream));
    console.log(`RESULT resume=${resume} gaps=${gaps.join(",")}`);
    // Following the stream: never more than one growth step behind.
    expect(Math.max(...gaps.slice(2))).toBeLessThan(200);
    await expect(
      page.getByRole("button", { name: "Scroll to newest messages" }),
    ).toHaveCount(0);
  });
}

async function atBottom(page: Page) {
  return (await gapFromBottom(page, "a")) < 60;
}

test("switching threads within a chat keeps each thread's reading position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`/?mode=chat-switch&reorder=0&chatMode=sidechat`);
  const a = page.getByTestId("log-a");
  await expect(a.locator("[data-item-index]").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await a.hover();
  // Thread A: read from the middle.
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -2500);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);
  const middleOfA = await readingPosition(page, "a");
  expect(await atBottom(page)).toBe(false);

  // Thread C: opened fresh, left at the bottom.
  await page.evaluate(() => (window as any).__chatThread("C"));
  await page.waitForTimeout(1500);
  expect(await atBottom(page)).toBe(true);

  // Back to A: its middle position, not C's bottom-following.
  await page.evaluate(() => (window as any).__chatThread("A"));
  await page.waitForTimeout(1500);
  const backToA = await readingPosition(page, "a");
  expect(Math.abs(backToA!.index - middleOfA!.index)).toBeLessThanOrEqual(1);

  // Back to C: still at the bottom.
  await page.evaluate(() => (window as any).__chatThread("C"));
  await page.waitForTimeout(1500);
  expect(await atBottom(page)).toBe(true);

  // And A once more after C was at the bottom.
  await page.evaluate(() => (window as any).__chatThread("A"));
  await page.waitForTimeout(1500);
  const againA = await readingPosition(page, "a");
  expect(Math.abs(againA!.index - middleOfA!.index)).toBeLessThanOrEqual(1);
});

test("a retained chat that was evicted remounts at its reading position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`/?mode=chat-switch&reorder=0&chatMode=sidechat`);
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
  await page.evaluate(() => (window as any).__chatSwitch("b"));
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as any).__chatEvict("a"));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as any).__chatEvict("a", false);
    (window as any).__chatSwitch("a");
  });
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(300);
    samples.push((await readingPosition(page, "a"))!.index);
  }
  console.log(`EVICT before=${before!.index} samples=${samples.join(",")}`);
  for (const index of samples.slice(1)) {
    expect(Math.abs(index - before!.index)).toBeLessThanOrEqual(1);
  }
});
