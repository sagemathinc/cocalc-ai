import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { project_id } from "@cocalc/project/data";
import {
  codeCell,
  countCells,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  resolveAcpMode,
  resolveBaseUrl,
  runLiteCliJson,
} from "./helpers";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const RUN_ACP_E2E =
  envFlag("COCALC_JUPYTER_E2E_ACP") || envFlag("COCALC_JUPYTER_E2E_AGENT");
const FIXTURE_PARENT = "/tmp/cocalc-lite3-generate-agent-e2e";

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

async function createWorkspaceFromCurrentDirectory(
  page: Page,
  workspaceRoot: string,
  workspaceTitle: string,
  testInfo: TestInfo,
): Promise<{ workspace_id: string }> {
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
  return {
    workspace_id: selected.workspace_id,
  };
}

async function openGenerateBelowModal(page: Page): Promise<void> {
  const insertBar = page.locator(".cocalc-jupyter-insert-cell").last();
  await insertBar.scrollIntoViewIfNeeded();
  await insertBar.hover();
  const generateButton = insertBar.getByRole("button", { name: /Generate/i });
  await expect(generateButton).toBeVisible({ timeout: 15_000 });
  await generateButton.click();
  const dialog = page.getByRole("dialog", { name: /Generate with Agent/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByText(/Target: generate new cells below this code cell\./i),
  ).toBeVisible({
    timeout: 15_000,
  });
}

function terminalStartCommands(activity: Record<string, any>): string[] {
  const events = Array.isArray(activity.events) ? activity.events : [];
  return events
    .filter(
      (row) =>
        row?.type === "event" &&
        row?.event?.type === "terminal" &&
        row?.event?.phase === "start",
    )
    .map((row) => `${row?.event?.command ?? ""}`.trim())
    .filter(Boolean);
}

function directNotebookFileOps(
  activity: Record<string, any>,
  pathIpynb: string,
): Array<Record<string, any>> {
  const events = Array.isArray(activity.events) ? activity.events : [];
  return events.filter(
    (row) =>
      row?.type === "event" &&
      row?.event?.type === "file" &&
      `${row?.event?.path ?? ""}`.trim() === pathIpynb,
  );
}

function suspiciousNotebookTerminalCommands(
  activity: Record<string, any>,
  pathIpynb: string,
): string[] {
  return terminalStartCommands(activity).filter((command) => {
    if (!command.includes(pathIpynb)) return false;
    if (command.includes("project jupyter")) return false;
    return true;
  });
}

async function waitForCompletedActivityLog(
  chatPath: string,
  threadId: string,
): Promise<Record<string, any>> {
  let latest: Record<string, any> | undefined;
  await expect
    .poll(
      async () => {
        try {
          latest = await runLiteCliJson([
            "project",
            "chat",
            "activity",
            "--path",
            chatPath,
            "--thread-id",
            threadId,
          ]);
        } catch (err) {
          const message = `${err ?? ""}`;
          if (message.includes("has no persisted Codex activity log")) {
            return "pending:no-log";
          }
          throw err;
        }
        const events = Array.isArray(latest?.events) ? latest.events : [];
        if (events.some((row) => row?.type === "error")) {
          return "error";
        }
        if (events.some((row) => row?.type === "summary")) {
          return "summary";
        }
        return `running:${events.length}`;
      },
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000],
      },
    )
    .toBe("summary");
  return latest ?? {};
}

test("Generate with Agent uses durable backend notebook operations", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const acpMode = await resolveAcpMode();
  test.skip(
    acpMode === "mock",
    "requires live Codex ACP mode; mock mode does not exercise notebook CLI behavior",
  );

  const workspaceSuffix = `jupyter-generate-agent-${Date.now().toString(36)}`;
  const workspaceRoot = join(FIXTURE_PARENT, workspaceSuffix);
  const path_ipynb = join(workspaceRoot, "generate.ipynb");
  await ensureNotebook(path_ipynb, [
    codeCell("anchor = 'keep this cell'\nanchor"),
  ]);

  const { base_url, auth_token } = await resolveBaseUrl();
  await openNotebookPage(
    page,
    notebookUrl({ base_url, path_ipynb, auth_token }),
    60_000,
  );
  const workspace = await createWorkspaceFromCurrentDirectory(
    page,
    workspaceRoot,
    workspaceSuffix,
    testInfo,
  );

  const initialCells = await runLiteCliJson([
    "project",
    "jupyter",
    "cells",
    "--path",
    path_ipynb,
  ]);
  const anchorCell = Array.isArray(initialCells.cells)
    ? initialCells.cells[0]
    : undefined;
  expect(anchorCell?.id).toBeTruthy();

  await openGenerateBelowModal(page);
  const dialog = page.getByRole("dialog", { name: /Generate with Agent/i });
  const prompt =
    "Insert exactly one new Python code cell below this code cell with `result = 2 + 3` on one line and `result` on the next line. Run the new cell.";
  const composer = dialog.getByRole("textbox").first();
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.click();
  await page.keyboard.type(prompt);
  const sendButton = dialog.getByRole("button", { name: /Send to Agent/i });
  await expect(sendButton).toBeEnabled({ timeout: 20_000 });
  await sendButton.click();
  await expect(dialog).toHaveCount(0, { timeout: 45_000 });
  await expect(
    page.getByText(/Generate new cells below this code cell:/i).first(),
  ).toBeVisible({
    timeout: 45_000,
  });
  await expect
    .poll(
      async () =>
        `${(await selectedWorkspaceState(page)).record?.chat_path ?? ""}`.trim(),
      {
        timeout: 45_000,
      },
    )
    .not.toBe("");
  const chatPath =
    `${(await selectedWorkspaceState(page)).record?.chat_path ?? ""}`.trim();

  const threadId = await waitForSelectedThreadKey(page);
  const activity = await waitForCompletedActivityLog(chatPath, threadId);
  const commands = terminalStartCommands(activity);
  const cellsAfter = await runLiteCliJson([
    "project",
    "jupyter",
    "cells",
    "--path",
    path_ipynb,
  ]);

  await testInfo.attach("activity-log.json", {
    body: JSON.stringify(activity, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("backend-cells.json", {
    body: JSON.stringify(cellsAfter, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("terminal-commands.json", {
    body: JSON.stringify(commands, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("workspace-state.json", {
    body: JSON.stringify(
      {
        workspace_id: workspace.workspace_id,
        chat_path: chatPath,
        thread_id: threadId,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  expect(commands.some((command) => command.includes("project jupyter"))).toBe(
    true,
  );
  expect(
    commands.some(
      (command) =>
        command.includes("project jupyter exec") ||
        command.includes("project jupyter run"),
    ),
  ).toBe(true);
  expect(directNotebookFileOps(activity, path_ipynb)).toEqual([]);
  expect(suspiciousNotebookTerminalCommands(activity, path_ipynb)).toEqual([]);

  const finalCells = Array.isArray(cellsAfter.cells) ? cellsAfter.cells : [];
  expect(finalCells).toHaveLength(2);
  expect(finalCells[0]?.id).toBe(anchorCell.id);
  expect(finalCells[1]?.index).toBe(1);
  expect(`${finalCells[1]?.input ?? ""}`).toContain("2 + 3");
  expect(`${finalCells[1]?.input ?? ""}`).toContain("result");

  await expect
    .poll(async () => await countCells(page), { timeout: 45_000 })
    .toBe(2);
});
