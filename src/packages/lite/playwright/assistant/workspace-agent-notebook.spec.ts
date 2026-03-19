import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  resolveBaseUrl,
} from "../jupyter/helpers";

const execFileAsync = promisify(execFile);

const FIXTURE_PARENT = "/home/wstein/scratch/cocalc-lite3-lite-daemon";

test.describe.configure({ mode: "serial" });

function cocalcCliPath(): string {
  const fromEnv = process.env.COCALC_CLI_BIN?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), "..", "cli", "dist", "bin", "cocalc.js");
}

async function backendExecJson(script: string): Promise<any> {
  const cli = cocalcCliPath();
  const { stdout } = await execFileAsync(cli, ["--json", "exec", script], {
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function ensureWorkspace(rootPath: string, title: string): Promise<any> {
  const payload = await backendExecJson(`
    const existing = await api.workspaces.resolve({ path: ${JSON.stringify(rootPath)} });
    if (!existing.workspace) {
      return await api.workspaces.create({
        rootPath: ${JSON.stringify(rootPath)},
        title: ${JSON.stringify(title)},
      });
    }
    return existing;
  `);
  return payload?.data?.result?.workspace;
}

function assistantButton(page: Page): Locator {
  return page
    .locator("button.ant-btn-compact-last-item")
    .filter({ has: page.locator("svg[viewBox='0 0 48 48']") })
    .first();
}

async function openAssistant(page: Page): Promise<void> {
  await expect(assistantButton(page)).toBeVisible({ timeout: 60_000 });
  await assistantButton(page).click();
}

async function waitForSelectedThreadKey(page: Page): Promise<string> {
  await expect
    .poll(
      async () =>
        (
          await page
            .locator("[data-selected-thread-key]")
            .first()
            .getAttribute("data-selected-thread-key")
        )?.trim() ?? "",
      { timeout: 45_000 },
    )
    .not.toBe("");
  return (
    (
      await page
        .locator("[data-selected-thread-key]")
        .first()
        .getAttribute("data-selected-thread-key")
    )?.trim() ?? ""
  );
}

async function expectWorkspaceOnlyOn(page: Page): Promise<void> {
  const dock = page.locator("[data-selected-thread-key]").first();
  await expect(dock.getByText("Only this workspace")).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        (await dock.locator(".ant-switch").first().getAttribute("class")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("ant-switch-checked");
}

async function submitAssistantRequest(
  page: Page,
  prompt: string,
): Promise<string> {
  await openAssistant(page);
  const composer = page.locator(
    "textarea[placeholder*='What should Codex do']",
  );
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/gpt-5\.4-mini/).first()).toBeVisible({
    timeout: 20_000,
  });
  await composer.fill(prompt);
  await page.getByRole("button", { name: /Send to Codex/i }).click();
  await expect(composer).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".cc-agent-dock-handle")).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
  await expectWorkspaceOnlyOn(page);
  return await waitForSelectedThreadKey(page);
}

test("title-bar assistant in notebooks reuses one workspace agent thread", async ({
  page,
}) => {
  const workspaceSuffix = `assistant-jupyter-e2e-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const notebookA = join(workspaceRoot, "assistant-a.ipynb");
  const notebookB = join(workspaceRoot, "assistant-b.ipynb");
  await ensureNotebook(notebookA, [codeCell("x = 1\nx")]);
  await ensureNotebook(notebookB, [codeCell("y = 2\ny")]);
  await ensureWorkspace(workspaceRoot, workspaceSuffix);

  const { base_url, auth_token } = await resolveBaseUrl();
  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookA }),
    60_000,
  );

  const firstPrompt =
    "Please add a markdown cell that says Notebook Harness One.";
  const firstThreadKey = await submitAssistantRequest(page, firstPrompt);

  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookB }),
    60_000,
  );

  const secondPrompt =
    "Please add a markdown cell that says Notebook Harness Two.";
  const secondThreadKey = await submitAssistantRequest(page, secondPrompt);

  expect(secondThreadKey).toBe(firstThreadKey);
});
