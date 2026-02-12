import { defineConfig } from "@playwright/test";

const port = Number(process.env.CHAT_PW_PORT || 4173);

export default defineConfig({
  testDir: "chat/playwright",
  timeout: 45_000,
  webServer: {
    command: "node chat/playwright/serve.js",
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
