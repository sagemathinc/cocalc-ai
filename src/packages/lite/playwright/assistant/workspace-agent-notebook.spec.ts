import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { project_id } from "@cocalc/project/data";
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

async function seedSelectedWorkspace(
  page: Page,
  workspace: {
    workspace_id: string;
    root_path: string;
    title?: string;
    description?: string;
    color?: string | null;
    accent_color?: string | null;
    icon?: string | null;
    image_blob?: string | null;
    pinned?: boolean;
    last_used_at?: number | null;
    last_active_path?: string | null;
    chat_path?: string | null;
    notice_thread_id?: string | null;
    notice?: any;
    source?: string | null;
    updated_at?: number;
  },
): Promise<void> {
  await page.addInitScript(
    ({ projectId, record }) => {
      sessionStorage.setItem(
        `project-workspace-selection:${projectId}`,
        JSON.stringify({
          kind: "workspace",
          workspace_id: record.workspace_id,
        }),
      );
      sessionStorage.setItem(
        `project-workspace-record:${projectId}`,
        JSON.stringify(record),
      );
    },
    {
      projectId: project_id,
      record: {
        workspace_id: workspace.workspace_id,
        project_id,
        root_path: workspace.root_path,
        theme: {
          title: `${workspace.title ?? ""}`.trim() || workspace.workspace_id,
          description: `${workspace.description ?? ""}`,
          color: workspace.color ?? null,
          accent_color: workspace.accent_color ?? null,
          icon: workspace.icon ?? null,
          image_blob: workspace.image_blob ?? null,
        },
        pinned: workspace.pinned ?? false,
        last_used_at: workspace.last_used_at ?? null,
        last_active_path: workspace.last_active_path ?? null,
        chat_path: workspace.chat_path ?? null,
        notice_thread_id: workspace.notice_thread_id ?? null,
        notice: workspace.notice ?? null,
        source: (workspace.source as any) ?? "manual",
        created_at: Date.now(),
        updated_at: workspace.updated_at ?? Date.now(),
      },
    },
  );
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

async function expectWorkspaceScope(
  page: Page,
  workspaceLabel: string,
): Promise<void> {
  const dock = page.locator("[data-selected-thread-key]").first();
  await expect(
    dock.getByText(`Workspace scope: ${workspaceLabel}`),
  ).toBeVisible({
    timeout: 20_000,
  });
}

async function reloadNotebookPage(page: Page): Promise<void> {
  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector('[cocalc-test="jupyter-cell"]', {
    timeout: 60_000,
  });
  await page.waitForSelector('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: 60_000,
  });
  await page.waitForTimeout(8_000);
}

async function submitAssistantRequest(
  page: Page,
  prompt: string,
  workspaceLabel: string,
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
  await expectPromptVisible(page, prompt);
  await expectWorkspaceOnlyOn(page);
  await expectWorkspaceScope(page, workspaceLabel);
  return await waitForSelectedThreadKey(page);
}

async function expectPromptVisible(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
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
  const workspace = await ensureWorkspace(workspaceRoot, workspaceSuffix);
  await seedSelectedWorkspace(page, workspace);

  const { base_url, auth_token } = await resolveBaseUrl();
  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookA }),
    60_000,
  );

  const firstPrompt =
    "Please add a markdown cell that says Notebook Harness One.";
  const firstThreadKey = await submitAssistantRequest(
    page,
    firstPrompt,
    workspaceSuffix,
  );

  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookB }),
    60_000,
  );

  const secondPrompt =
    "Please add a markdown cell that says Notebook Harness Two.";
  const secondThreadKey = await submitAssistantRequest(
    page,
    secondPrompt,
    workspaceSuffix,
  );

  expect(secondThreadKey).toBe(firstThreadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);

  await reloadNotebookPage(page);

  const thirdPrompt =
    "Please add a markdown cell that says Notebook Harness Three.";
  const thirdThreadKey = await submitAssistantRequest(
    page,
    thirdPrompt,
    workspaceSuffix,
  );

  expect(thirdThreadKey).toBe(firstThreadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);
  await expectPromptVisible(page, thirdPrompt);
});
