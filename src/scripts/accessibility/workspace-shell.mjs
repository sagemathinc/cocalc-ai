import assert from "node:assert/strict";

// Run on a signed-in Projects or project editor page. No file writes, messages,
// or agent runs. Leaves the sidebar open on desktop and closed on narrow screens.
export async function checkWorkspaceSidebar(page, { narrow = false } = {}) {
  const hide = page.getByRole("button", {
    name: "Hide Agents sidebar",
    exact: true,
  });
  const show = page.getByRole("button", {
    name: narrow ? "Show agents" : "Show Agents sidebar",
    exact: true,
  });
  if (!(await hide.isVisible())) await show.click();
  const projects = page
    .getByRole("complementary", { name: "Agents" })
    .getByRole("button", { name: "Projects", exact: true });
  assert.equal(await projects.getAttribute("aria-current"), "page");
  await hide.focus();
  await page.keyboard.press("Enter");
  await show.waitFor({ state: "visible" });
  assert(await show.evaluate((button) => button === document.activeElement));
  const bounds = await show.boundingBox();
  const width = await page.evaluate(() => innerWidth);
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
  await page.keyboard.press("Enter");
  await hide.waitFor({ state: "visible" });
  assert(await hide.evaluate((button) => button === document.activeElement));
  if (narrow) {
    await page.keyboard.press("Enter");
    await show.waitFor({ state: "visible" });
  }
}

// Start with an existing file open and choose an agent in a different project.
// The retained project container and exact file URL must survive the round trip.
export async function checkWorkspaceProjectHistory(page, agentAccessibleName) {
  const fileUrl = page.url();
  const project = await page
    .locator(".container-content")
    .last()
    .elementHandle();
  assert(project, "Open a project file before checking its retained view");
  await page
    .getByRole("complementary", { name: "Agents" })
    .getByRole("button", { name: agentAccessibleName, exact: true })
    .click();
  await page.waitForURL(/\/u\/.+\/agents\//);
  assert(await project.evaluate((element) => element.isConnected));
  await page.goBack();
  await page.waitForURL(fileUrl);
  assert(await project.evaluate((element) => element.isConnected));
}
