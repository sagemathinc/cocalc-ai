import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { project_id } from "@cocalc/project/data";
import { resolveBaseUrl } from "../jupyter/helpers";

const execFileAsync = promisify(execFile);

const FIXTURE_PARENT = "/home/wstein/scratch/cocalc-lite3-lite-daemon";

test.describe.configure({ mode: "serial" });

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function encodeProjectPath(path: string): string {
  if (path.startsWith("/")) {
    return `%2F${encodeURI(path.slice(1))
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F")}`;
  }
  return encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function fileUrl(opts: {
  base_url: string;
  path: string;
  auth_token?: string;
}): string {
  const base = new URL(
    opts.base_url.endsWith("/") ? opts.base_url : `${opts.base_url}/`,
  );
  const url = new URL(
    `projects/${project_id}/files/${encodeProjectPath(opts.path)}`,
    base,
  );
  if (opts.auth_token) {
    url.searchParams.set("auth_token", opts.auth_token);
  }
  return url.toString();
}

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

async function writeFixture(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function assistantButton(page: Page): Locator {
  return page
    .locator("button.ant-btn-compact-last-item")
    .filter({ has: page.locator("svg[viewBox='0 0 48 48']") })
    .first();
}

async function openAssistantPopover(page: Page): Promise<void> {
  const opened = await page.evaluate(() => {
    const button =
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button.ant-btn-compact-last-item",
        ),
      ).find((x) => x.querySelector("svg[viewBox='0 0 48 48']")) ??
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (x) => x.querySelector("svg[viewBox='0 0 48 48']"),
      );
    if (!button) return false;
    button.click();
    return true;
  });
  expect(opened).toBe(true);
}

async function openMarkdownFile(page: Page, url: string): Promise<void> {
  await page.goto(trimTrailingSlash(url), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(assistantButton(page)).toBeVisible({ timeout: 60_000 });
}

async function reloadMarkdownFile(page: Page): Promise<void> {
  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(assistantButton(page)).toBeVisible({ timeout: 60_000 });
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

async function submitAssistantRequest(
  page: Page,
  prompt: string,
  workspaceLabel: string,
): Promise<{
  threadKey: string;
}> {
  await openAssistantPopover(page);
  const composer = page.locator(
    "textarea[placeholder*='What should Codex do']",
  );
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/gpt-5\.4-mini/).first()).toBeVisible({
    timeout: 20_000,
  });
  await composer.fill(prompt);
  const sendButton = page.getByRole("button", { name: /Send to Codex/i });
  await expect(sendButton).toBeEnabled({ timeout: 20_000 });
  await sendButton.click();
  await expect(composer).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".cc-agent-dock-handle")).toBeVisible({
    timeout: 45_000,
  });
  await expectPromptVisible(page, prompt);
  await expectWorkspaceScope(page, workspaceLabel);
  return { threadKey: await waitForSelectedThreadKey(page) };
}

async function expectPromptVisible(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
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
  await expect
    .poll(
      async () =>
        (await dock.locator(".ant-switch").first().getAttribute("class")) ?? "",
      { timeout: 20_000 },
    )
    .toContain("ant-switch-checked");
}

test("title-bar assistant reuses one workspace agent thread across files", async ({
  page,
}) => {
  const workspaceSuffix = `assistant-e2e-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const pathA = join(workspaceRoot, "assistant-agent-a.md");
  const pathB = join(workspaceRoot, "assistant-agent-b.md");
  await writeFixture(pathA, "# Golden Harness A\n\nhello from a\n");
  await writeFixture(pathB, "# Golden Harness B\n\nhello from b\n");
  const workspace = await ensureWorkspace(workspaceRoot, workspaceSuffix);
  await seedSelectedWorkspace(page, workspace);

  const { base_url, auth_token } = await resolveBaseUrl();
  await openMarkdownFile(page, fileUrl({ base_url, auth_token, path: pathA }));

  const firstPrompt = "Please add a heading that says Golden Harness One.";
  const first = await submitAssistantRequest(
    page,
    firstPrompt,
    workspaceSuffix,
  );

  await openMarkdownFile(page, fileUrl({ base_url, auth_token, path: pathB }));

  const secondPrompt =
    "Please add a final sentence that says Golden Harness Two.";
  const second = await submitAssistantRequest(
    page,
    secondPrompt,
    workspaceSuffix,
  );

  expect(second.threadKey).toBe(first.threadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);

  await reloadMarkdownFile(page);

  const thirdPrompt = "Please rewrite the first paragraph in a shorter style.";
  const third = await submitAssistantRequest(
    page,
    thirdPrompt,
    workspaceSuffix,
  );

  expect(third.threadKey).toBe(first.threadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);
  await expectPromptVisible(page, thirdPrompt);
});
