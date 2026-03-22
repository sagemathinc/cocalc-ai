import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { project_id } from "@cocalc/project/data";

const FIXTURE_PARENT = "/tmp/cocalc-lite3-assistant-e2e";
const DEFAULT_ASSISTANT_BASE_URL = "http://localhost:7003";

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

function resolveAssistantBaseUrl(): { base_url: string; auth_token?: string } {
  const explicitBaseUrl =
    process.env.COCALC_ASSISTANT_E2E_BASE_URL?.trim() ||
    DEFAULT_ASSISTANT_BASE_URL;
  const auth_token = process.env.COCALC_ASSISTANT_E2E_AUTH_TOKEN?.trim();
  return { base_url: explicitBaseUrl, auth_token: auth_token || undefined };
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

async function captureWorkspaceDebugState(
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  const payload = await page.evaluate(
    ({ projectId }) => {
      const keySelection = `project-workspace-selection:${projectId}`;
      const keyRecord = `project-workspace-record:${projectId}`;
      const cc: any = (window as any).cc ?? (window as any).cocalc;
      const projectStore = cc?.redux?.getProjectStore?.(projectId);
      return {
        location: window.location.href,
        sessionSelection: sessionStorage.getItem(keySelection),
        sessionWorkspaceRecord: sessionStorage.getItem(keyRecord),
        activeProjectTab: projectStore?.get?.("active_project_tab"),
        currentPathAbs: projectStore?.get?.("current_path_abs"),
        selectionTrace:
          (window as any).__assistantWorkspaceSelectionTrace ?? [],
      };
    },
    { projectId: project_id },
  );
  await testInfo.attach(label, {
    body: JSON.stringify(payload, null, 2),
    contentType: "application/json",
  });
}

async function selectedWorkspaceState(page: Page): Promise<{
  workspace_id: string;
  record: any | null;
}> {
  return await page.evaluate(
    ({ projectId }) => {
      const rawSelection = sessionStorage.getItem(
        `project-workspace-selection:${projectId}`,
      );
      const rawRecord = sessionStorage.getItem(
        `project-workspace-record:${projectId}`,
      );
      let workspace_id = "";
      let record: any | null = null;
      try {
        workspace_id = rawSelection
          ? (JSON.parse(rawSelection)?.workspace_id ?? "")
          : "";
      } catch {}
      try {
        record = rawRecord ? JSON.parse(rawRecord) : null;
      } catch {}
      return { workspace_id, record };
    },
    { projectId: project_id },
  );
}

async function installWorkspaceSelectionTrace(page: Page): Promise<void> {
  await page.addInitScript(
    ({ projectId }) => {
      const keySelection = `project-workspace-selection:${projectId}`;
      const trace: any[] = [];
      const limit = 200;
      const push = (entry: Record<string, unknown>) => {
        trace.push({
          at: new Date().toISOString(),
          href: window.location.href,
          ...entry,
        });
        if (trace.length > limit) {
          trace.splice(0, trace.length - limit);
        }
        (window as any).__assistantWorkspaceSelectionTrace = trace;
      };

      const storageProto = Storage.prototype as Storage & {
        __assistantWorkspaceSelectionWrapped?: boolean;
      };
      if (!storageProto.__assistantWorkspaceSelectionWrapped) {
        storageProto.__assistantWorkspaceSelectionWrapped = true;
        const originalSetItem = storageProto.setItem;
        const originalRemoveItem = storageProto.removeItem;
        storageProto.setItem = function (key: string, value: string): void {
          if (key === keySelection) {
            push({
              op: "setItem",
              key,
              value,
              stack: new Error().stack ?? "",
            });
          }
          return originalSetItem.call(this, key, value);
        };
        storageProto.removeItem = function (key: string): void {
          if (key === keySelection) {
            push({
              op: "removeItem",
              key,
              stack: new Error().stack ?? "",
            });
          }
          return originalRemoveItem.call(this, key);
        };
      }

      window.addEventListener("cocalc:project-workspace-selection", (event) => {
        const detail = (event as CustomEvent)?.detail;
        if (`${detail?.project_id ?? ""}` !== projectId) return;
        push({
          op: "event",
          detail,
          sessionSelection: sessionStorage.getItem(keySelection),
        });
      });
    },
    { projectId: project_id },
  );
}

async function createWorkspaceFromCurrentDirectory(
  page: Page,
  workspaceRoot: string,
  workspaceTitle: string,
  testInfo: TestInfo,
): Promise<{ workspace_id: string; root_path: string; title: string }> {
  await page.getByText("Workspaces", { exact: true }).first().click();
  await page.getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New Workspace" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const inputs = dialog.locator("input");
  await expect(inputs.nth(0)).toHaveValue(workspaceRoot, { timeout: 15_000 });
  await inputs.nth(1).fill(workspaceTitle);
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => await selectedWorkspaceState(page), {
      timeout: 30_000,
    })
    .toMatchObject({
      workspace_id: expect.any(String),
      record: expect.objectContaining({ root_path: workspaceRoot }),
    });
  const selected = await selectedWorkspaceState(page);
  const record = selected.record;
  if (
    selected.workspace_id === "" ||
    `${record?.root_path ?? ""}` !== workspaceRoot
  ) {
    await captureWorkspaceDebugState(
      page,
      testInfo,
      "workspace-create-selection-mismatch",
    );
    throw new Error(
      `workspace create mismatch: selected=${selected.workspace_id} root=${record?.root_path ?? ""}`,
    );
  }
  await page.locator("[role='tab']").first().click();
  await expect(assistantButton(page)).toBeVisible({ timeout: 30_000 });
  return {
    workspace_id: selected.workspace_id,
    root_path: workspaceRoot,
    title: workspaceTitle,
  };
}

async function waitForSelectedThreadKey(page: Page): Promise<string> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ projectId }) => {
            const rawRecord = sessionStorage.getItem(
              `project-workspace-record:${projectId}`,
            );
            if (!rawRecord) return "";
            let chatPath = "";
            try {
              chatPath = `${JSON.parse(rawRecord)?.chat_path ?? ""}`.trim();
            } catch {}
            if (!chatPath) return "";
            return (
              localStorage.getItem(
                `cocalc:navigator:selected-thread:chat:${encodeURIComponent(chatPath)}`,
              ) ?? ""
            ).trim();
          },
          { projectId: project_id },
        ),
      { timeout: 45_000 },
    )
    .not.toBe("");
  return await page.evaluate(
    ({ projectId }) => {
      const rawRecord = sessionStorage.getItem(
        `project-workspace-record:${projectId}`,
      );
      if (!rawRecord) return "";
      let chatPath = "";
      try {
        chatPath = `${JSON.parse(rawRecord)?.chat_path ?? ""}`.trim();
      } catch {}
      if (!chatPath) return "";
      return (
        localStorage.getItem(
          `cocalc:navigator:selected-thread:chat:${encodeURIComponent(chatPath)}`,
        ) ?? ""
      ).trim();
    },
    { projectId: project_id },
  );
}

async function submitAssistantRequest(
  page: Page,
  prompt: string,
  _workspaceLabel: string,
  testInfo: TestInfo,
): Promise<{
  threadKey: string;
}> {
  await captureWorkspaceDebugState(page, testInfo, "before-assistant-submit");
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
  await expectPromptVisible(page, prompt);
  await expectWorkspaceOnlyOn(page);
  return { threadKey: await waitForSelectedThreadKey(page) };
}

async function expectPromptVisible(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
}

async function expectWorkspaceOnlyOn(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ projectId }) =>
            localStorage.getItem(`agents-panel-workspace-only:${projectId}`) ??
            "",
          { projectId: project_id },
        ),
      { timeout: 20_000 },
    )
    .toBe("true");
}

test("title-bar assistant reuses one workspace agent thread across files", async ({
  page,
}, testInfo) => {
  await installWorkspaceSelectionTrace(page);
  const workspaceSuffix = `assistant-e2e-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const pathA = join(workspaceRoot, "assistant-agent-a.md");
  const pathB = join(workspaceRoot, "assistant-agent-b.md");
  console.log("markdown assistant step:writing-fixtures");
  await writeFixture(pathA, "# Golden Harness A\n\nhello from a\n");
  await writeFixture(pathB, "# Golden Harness B\n\nhello from b\n");
  console.log("markdown assistant step:fixtures-written");
  const { base_url, auth_token } = resolveAssistantBaseUrl();
  console.log("markdown assistant step:resolved-base-url", base_url);
  await openMarkdownFile(page, fileUrl({ base_url, auth_token, path: pathA }));
  console.log("markdown assistant step:first-file-opened");
  const workspace = await createWorkspaceFromCurrentDirectory(
    page,
    workspaceRoot,
    workspaceSuffix,
    testInfo,
  );
  console.log(
    "markdown assistant step:workspace-ready",
    workspace?.workspace_id,
    workspace?.root_path,
  );
  console.log("markdown assistant step:workspace-selection-established");

  const firstPrompt = "Please add a heading that says Golden Harness One.";
  const first = await submitAssistantRequest(
    page,
    firstPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-agent-a\.md/, { timeout: 20_000 });
  console.log("markdown assistant step:first-complete", first.threadKey);

  await openMarkdownFile(page, fileUrl({ base_url, auth_token, path: pathB }));
  console.log("markdown assistant step:opened-second-file");

  const secondPrompt =
    "Please add a final sentence that says Golden Harness Two.";
  const second = await submitAssistantRequest(
    page,
    secondPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-agent-b\.md/, { timeout: 20_000 });
  console.log("markdown assistant step:second-complete", second.threadKey);

  expect(second.threadKey).toBe(first.threadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);

  await reloadMarkdownFile(page);
  console.log("markdown assistant step:reloaded");

  const thirdPrompt = "Please rewrite the first paragraph in a shorter style.";
  const third = await submitAssistantRequest(
    page,
    thirdPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-agent-b\.md/, { timeout: 20_000 });
  console.log("markdown assistant step:third-complete", third.threadKey);

  expect(third.threadKey).toBe(first.threadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);
  await expectPromptVisible(page, thirdPrompt);
});
