import { defineConfig } from "@playwright/test";

const port = Number(process.env.SLATE_PW_PORT || 4172);

export default defineConfig({
  testDir: "editors/slate/playwright",
  timeout: 30_000,
  webServer: {
    command: "node editors/slate/playwright/serve.js",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
