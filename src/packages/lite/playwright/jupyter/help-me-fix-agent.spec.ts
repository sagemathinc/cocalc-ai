import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  resolveBaseUrl,
  resolveLiteDaemonHome,
  uniqueNotebookPath,
} from "./helpers";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const RUN_ACP_E2E =
  envFlag("COCALC_JUPYTER_E2E_ACP") || envFlag("COCALC_JUPYTER_E2E_AGENT");

test.describe.configure({ mode: "serial" });

test.skip(
  !RUN_ACP_E2E,
  "Set COCALC_JUPYTER_E2E_ACP=1 (or COCALC_JUPYTER_E2E_AGENT=1) to run ACP integration tests.",
);

test("Fix with Agent opens floating navigator and sends prompt in-place", async ({
  page,
}) => {
  const { base_url, auth_token } = await resolveBaseUrl();
  const liteHome = await resolveLiteDaemonHome();
  const navigatorChatPath = join(liteHome, ".local", "share", "cocalc", "navigator.chat");
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-help-me-fix-agent");
  await ensureNotebook(path_ipynb, [
    codeCell("1/0", {
      execution_count: 1,
      outputs: [
        {
          output_type: "error",
          ename: "ZeroDivisionError",
          evalue: "division by zero",
          traceback: [
            "Traceback (most recent call last):",
            "ZeroDivisionError: division by zero",
          ],
        },
      ],
    }),
  ]);

  const url = notebookUrl({ base_url, path_ipynb, auth_token });
  await openNotebookPage(page, url, 60_000);

  const fixButton = page.getByRole("button", { name: /Fix with Agent/i });
  await expect(fixButton).toBeVisible({ timeout: 30_000 });
  await fixButton.click();

  await expect(page.locator(".cc-agent-dock-handle")).toBeVisible({
    timeout: 45_000,
  });
  await expect(page).toHaveURL(/\/projects\/[^/]+\/files\//);

  await expect
    .poll(
      async () => {
        try {
          const raw = await readFile(navigatorChatPath, "utf8");
          return raw.includes("Investigate and fix this Jupyter notebook error.");
        } catch {
          return false;
        }
      },
      { timeout: 45_000 },
    )
    .toBe(true);
});
