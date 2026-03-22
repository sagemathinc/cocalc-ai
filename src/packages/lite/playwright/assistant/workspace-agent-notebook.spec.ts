import { join } from "node:path";

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { project_id } from "@cocalc/project/data";
import {
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
} from "../jupyter/helpers";

const FIXTURE_PARENT = "/tmp/cocalc-lite3-assistant-e2e";
const DEFAULT_ASSISTANT_BASE_URL = "http://localhost:7003";

test.describe.configure({ mode: "serial" });

function resolveAssistantBaseUrl(): { base_url: string; auth_token?: string } {
  const explicitBaseUrl =
    process.env.COCALC_ASSISTANT_E2E_BASE_URL?.trim() ||
    DEFAULT_ASSISTANT_BASE_URL;
  const auth_token = process.env.COCALC_ASSISTANT_E2E_AUTH_TOKEN?.trim();
  return { base_url: explicitBaseUrl, auth_token: auth_token || undefined };
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
  _workspaceLabel: string,
  testInfo: TestInfo,
): Promise<string> {
  await captureWorkspaceDebugState(page, testInfo, "before-assistant-submit");
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
  await expectPromptVisible(page, prompt);
  await expectWorkspaceOnlyOn(page);
  return await waitForSelectedThreadKey(page);
}

async function expectPromptVisible(page: Page, prompt: string): Promise<void> {
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
}

test("title-bar assistant in notebooks reuses one workspace agent thread", async ({
  page,
}, testInfo) => {
  await installWorkspaceSelectionTrace(page);
  const workspaceSuffix = `assistant-jupyter-e2e-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const notebookA = join(workspaceRoot, "assistant-a.ipynb");
  const notebookB = join(workspaceRoot, "assistant-b.ipynb");
  await ensureNotebook(notebookA, [codeCell("x = 1\nx")]);
  await ensureNotebook(notebookB, [codeCell("y = 2\ny")]);
  const { base_url, auth_token } = resolveAssistantBaseUrl();
  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookA }),
    60_000,
  );
  await createWorkspaceFromCurrentDirectory(
    page,
    workspaceRoot,
    workspaceSuffix,
    testInfo,
  );

  const firstPrompt =
    "Please add a markdown cell that says Notebook Harness One.";
  const firstThreadKey = await submitAssistantRequest(
    page,
    firstPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-a\.ipynb/, { timeout: 20_000 });
  console.log("notebook assistant step:first-complete", firstThreadKey);

  await openNotebookPage(
    page,
    notebookUrl({ base_url, auth_token, path_ipynb: notebookB }),
    60_000,
  );
  console.log("notebook assistant step:opened-second-file");

  const secondPrompt =
    "Please add a markdown cell that says Notebook Harness Two.";
  const secondThreadKey = await submitAssistantRequest(
    page,
    secondPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-b\.ipynb/, { timeout: 20_000 });
  console.log("notebook assistant step:second-complete", secondThreadKey);

  expect(secondThreadKey).toBe(firstThreadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);

  await reloadNotebookPage(page);
  console.log("notebook assistant step:reloaded");

  const thirdPrompt =
    "Please add a markdown cell that says Notebook Harness Three.";
  const thirdThreadKey = await submitAssistantRequest(
    page,
    thirdPrompt,
    workspaceSuffix,
    testInfo,
  );
  await expect(page).toHaveURL(/assistant-b\.ipynb/, { timeout: 20_000 });
  console.log("notebook assistant step:third-complete", thirdThreadKey);

  expect(thirdThreadKey).toBe(firstThreadKey);
  await expectPromptVisible(page, firstPrompt);
  await expectPromptVisible(page, secondPrompt);
  await expectPromptVisible(page, thirdPrompt);
});
