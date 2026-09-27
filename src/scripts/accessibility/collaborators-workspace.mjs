import assert from "node:assert/strict";

async function focused(locator) {
  await locator.waitFor();
  await locator.evaluate(async (element) => {
    const deadline = performance.now() + 5000;
    while (document.activeElement !== element) {
      if (performance.now() > deadline) throw Error("Expected keyboard focus");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

async function keyboardActivate(page, locator) {
  await locator.focus();
  await focused(locator);
  await page.keyboard.press("Enter");
}

async function withinViewport(page, locator) {
  let rect;
  // Account projection refreshes may replace a row while a view save settles.
  // Re-resolve the locator, but still fail persistent invisibility or overflow.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await locator.scrollIntoViewIfNeeded();
      rect = await locator.boundingBox();
      if (rect) break;
    } catch (error) {
      if (attempt === 2 || !String(error).includes("not attached")) throw error;
    }
    await page.waitForTimeout(100);
  }
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert(rect && rect.width > 0 && rect.height > 0, "Control must be visible");
  assert(
    rect.x >= -1 && rect.x + rect.width <= viewport.width + 1,
    "Control must fit horizontally",
  );
  assert(
    rect.y >= -1 && rect.y + rect.height <= viewport.height + 1,
    "Control must be reachable vertically",
  );
}

// Shared by Artifacts and all populated Collaborators collections. This only
// changes the view preference and restores it; pin order is not modified.
export async function checkCollectionViews(page, label, pinnedTitle) {
  const controls = page.getByRole("group", {
    name: `${label} view`,
    exact: true,
  });
  const grid = controls.getByRole("button", { name: "Grid view", exact: true });
  const list = controls.getByRole("button", { name: "List view", exact: true });
  await controls.waitFor();
  const wasGrid = (await grid.getAttribute("aria-pressed")) === "true";
  try {
    for (const mode of [grid, list]) {
      await keyboardActivate(page, mode);
      await focused(mode);
      assert.equal(await mode.getAttribute("aria-pressed"), "true");
      await withinViewport(page, mode);
      await focused(mode);
      if (pinnedTitle) {
        const reorder = page
          .getByRole("button", {
            name: `Reorder ${pinnedTitle}`,
            exact: true,
          })
          .or(
            page.getByRole("button", {
              name: `More options for ${pinnedTitle}`,
              exact: true,
            }),
          );
        await keyboardActivate(page, reorder);
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        await focused(reorder);
        await withinViewport(
          page,
          page.getByRole("button", {
            name: `Drag ${pinnedTitle} to reorder`,
            exact: true,
          }),
        );
      }
    }
  } finally {
    await keyboardActivate(page, wasGrid ? grid : list);
    await focused(wasGrid ? grid : list);
  }
}

// Use an isolated fixture. The pin is toggled and then restored; no access or
// project settings are changed. Caller selects the account/theme/viewport.
export async function checkCollaboratorsProjectPins(page, projectTitle) {
  const views = page.getByRole("navigation", { name: "Collaborators views" });
  await keyboardActivate(
    page,
    views.getByRole("button", { name: "Projects", exact: true }),
  );
  await keyboardActivate(
    page,
    page.getByRole("button", { name: "Recent projects", exact: true }),
  );
  const pin = page.getByRole("button", {
    name: `Pin project ${projectTitle}`,
    exact: true,
  });
  const unpin = page.getByRole("button", {
    name: `Unpin project ${projectTitle}`,
    exact: true,
  });
  await pin.or(unpin).waitFor();
  const wasPinned = await unpin.isVisible();
  try {
    if (!wasPinned) {
      await keyboardActivate(page, pin);
      await focused(unpin);
    }
    await keyboardActivate(
      page,
      page.getByRole("button", { name: "Pinned projects", exact: true }),
    );
    await unpin.waitFor();
    assert.equal(await unpin.getAttribute("aria-pressed"), "true");
    await withinViewport(page, unpin);
    await keyboardActivate(page, unpin);
    await unpin.waitFor({ state: "hidden" });
    await focused(page.getByLabel("Collaborators results", { exact: true }));
    await keyboardActivate(
      page,
      page.getByRole("button", { name: "Recent projects", exact: true }),
    );
    await pin.waitFor();
    assert.equal(await pin.getAttribute("aria-pressed"), "false");
  } finally {
    await page
      .getByRole("button", { name: "Recent projects", exact: true })
      .click();
    await pin.or(unpin).waitFor();
    if (wasPinned && (await pin.isVisible())) await pin.click();
    if (!wasPinned && (await unpin.isVisible())) await unpin.click();
    await (wasPinned ? unpin : pin).waitFor();
  }
}

// Caller opens a resource overview and provides the destination button's full
// accessible name. The default only inspects/cancels. Opt-in draft mutation is
// for disposable fixtures; it never sends a message or invokes an agent.
export async function checkCollaboratorsSharing(
  page,
  { destinationName, addReference = false },
) {
  const trigger = page.getByRole("button", {
    name: "Share to conversation",
    exact: true,
  });
  const dialog = page.getByRole("dialog", {
    name: "Share to conversation",
    exact: true,
  });
  await keyboardActivate(page, trigger);
  await focused(dialog.getByRole("textbox", { name: "Search conversations" }));
  const destination = dialog.getByRole("button", {
    name: destinationName,
    exact: true,
  });
  await destination.waitFor();
  await withinViewport(page, destination);
  await keyboardActivate(page, destination);
  await focused(dialog.getByRole("heading", { name: /^Destination:/ }));
  assert.match(await dialog.innerText(), /all collaborators in/);
  const add = dialog.getByRole("button", {
    name: "Add reference to draft",
    exact: true,
  });
  await withinViewport(page, add);
  if (addReference) {
    await keyboardActivate(page, add);
    await focused(
      dialog.getByRole("heading", { name: "Reference added to draft" }),
    );
    assert.match(await dialog.innerText(), /Nothing was sent/);
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await focused(trigger);
}
