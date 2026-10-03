import { defineConfig } from "@playwright/test";

// Multi-user collaboration tests against a running Lite server (see
// playwright/collab/README.md). Long-running by design.
export default defineConfig({
  testDir: "playwright/collab",
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true },
  // COLLAB_CHROME: a Chromium executable to use instead of Playwright's own.
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: process.env.COLLAB_CHROME
          ? { executablePath: process.env.COLLAB_CHROME }
          : {},
      },
    },
  ],
});
