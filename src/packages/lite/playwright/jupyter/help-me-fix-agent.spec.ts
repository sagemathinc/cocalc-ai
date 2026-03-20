import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { project_id } from "@cocalc/project/data";
import {
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  resolveAcpMode,
  resolveBaseUrl,
} from "./helpers";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const RUN_ACP_E2E =
  envFlag("COCALC_JUPYTER_E2E_ACP") || envFlag("COCALC_JUPYTER_E2E_AGENT");
const ALLOW_NON_MOCK = envFlag("COCALC_JUPYTER_E2E_ALLOW_NON_MOCK");
const FIXTURE_PARENT = "/tmp/cocalc-lite3-help-me-fix-e2e";

test.describe.configure({ mode: "serial" });

test.skip(
  !RUN_ACP_E2E,
  "Set COCALC_JUPYTER_E2E_ACP=1 (or COCALC_JUPYTER_E2E_AGENT=1) to run ACP integration tests.",
);

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

type ChatJsonLine = Record<string, any>;

async function readChatJsonLines(path: string): Promise<ChatJsonLine[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function chatPathFromPageUrl(url: string): string {
  const match = url.match(/\/files\/(.+?\.chat)(?:[#?].*)?$/);
  if (!match) return "";
  const decoded = decodeURIComponent(match[1]);
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

async function createWorkspaceFromCurrentDirectory(
  page: Page,
  workspaceRoot: string,
  workspaceTitle: string,
  testInfo: TestInfo,
): Promise<void> {
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
  if (
    selected.workspace_id === "" ||
    `${selected.record?.root_path ?? ""}` !== workspaceRoot
  ) {
    await testInfo.attach("workspace-selection", {
      body: JSON.stringify(selected, null, 2),
      contentType: "application/json",
    });
    throw new Error(
      `workspace create mismatch: selected=${selected.workspace_id} root=${selected.record?.root_path ?? ""}`,
    );
  }
  await page.locator("[role='tab']").first().click();
}

test("Fix with Agent opens workspace chat and submits in place", async ({
  page,
}, testInfo) => {
  const acpMode = await resolveAcpMode();
  test.skip(
    !ALLOW_NON_MOCK && acpMode != null && acpMode !== "mock",
    `requires ACP mock mode (detected: ${acpMode ?? "unknown"})`,
  );

  const { base_url, auth_token } = await resolveBaseUrl();
  const workspaceSuffix = `jupyter-e2e-help-fix-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const path_ipynb = join(workspaceRoot, "error.ipynb");
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
  await createWorkspaceFromCurrentDirectory(
    page,
    workspaceRoot,
    workspaceSuffix,
    testInfo,
  );
  const fixButton = page.getByRole("button", { name: /Fix with Agent/i });
  await expect(fixButton).toBeVisible({ timeout: 30_000 });
  const clickStarted = Date.now();
  await fixButton.click();

  await expect(page).toHaveURL(/\.chat/, {
    timeout: 12_000,
  });
  const chatPath = chatPathFromPageUrl(page.url());
  expect(chatPath).not.toBe("");
  expect(Date.now() - clickStarted).toBeLessThan(12_000);
  await expect(
    page.getByText("Investigate and fix this Jupyter notebook error.").first(),
  ).toBeVisible({
    timeout: 12_000,
  });
  await expect(page.getByText("Fix notebook error").first()).toBeVisible({
    timeout: 12_000,
  });
  await expect(page.locator(".cc-agent-dock-handle")).toHaveCount(1, {
    timeout: 12_000,
  });
  await expect
    .poll(
      async () => {
        const rows = await readChatJsonLines(chatPath);
        const userRow = rows.find(
          (row) =>
            row?.event === "chat" &&
            row?.sender_id === "00000000-1000-4000-8000-000000000001" &&
            row?.history?.[0]?.content ===
              "Investigate and fix this Jupyter notebook error.",
        );
        const threadId = `${userRow?.thread_id ?? ""}`.trim();
        const assistantRow =
          threadId === ""
            ? undefined
            : rows.find(
                (row) =>
                  row?.event === "chat" &&
                  `${row?.thread_id ?? ""}`.trim() === threadId &&
                  `${row?.sender_id ?? ""}`.trim() !==
                    "00000000-1000-4000-8000-000000000001",
              );
        const threadState =
          threadId === ""
            ? undefined
            : rows.find(
                (row) =>
                  row?.event === "chat-thread-state" &&
                  `${row?.thread_id ?? ""}`.trim() === threadId,
              );
        return {
          rowCount: rows.length,
          threadId,
          assistantSender: `${assistantRow?.sender_id ?? ""}`.trim(),
          threadState: `${threadState?.state ?? ""}`.trim(),
        };
      },
      { timeout: 30_000 },
    )
    .toMatchObject({
      threadId: expect.any(String),
      assistantSender: expect.stringMatching(/\S/),
    });
  const finalRows = await readChatJsonLines(chatPath);
  const finalUserRow = finalRows.find(
    (row) =>
      row?.event === "chat" &&
      row?.sender_id === "00000000-1000-4000-8000-000000000001" &&
      row?.history?.[0]?.content ===
        "Investigate and fix this Jupyter notebook error.",
  );
  expect(`${finalUserRow?.thread_id ?? ""}`.trim()).not.toBe("");
});
