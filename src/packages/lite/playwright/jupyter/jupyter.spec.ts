import { expect, test } from "@playwright/test";
import {
  clickRunButton,
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  readCellText,
  readInputExecCount,
  readRunButtonLabel,
  resolveBaseUrl,
  setCellInputCode,
  uniqueNotebookPath,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("runs a cell and shows output", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-run-smoke");
  await ensureNotebook(path_ipynb, [codeCell("2+3")]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  const beforeExec = await readInputExecCount(page, 0);
  await clickRunButton(page, 0);
  await expect
    .poll(async () => await readInputExecCount(page, 0), {
      timeout: 30_000,
    })
    .not.toBe(beforeExec);
});

test("running cell state syncs across tabs", async ({ browser }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-running-sync");
  await ensureNotebook(path_ipynb, [codeCell("import time\ntime.sleep(4)\nprint('hi-sync')")]);
  const url = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
  });

  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await openNotebookPage(pageA, url);
    await openNotebookPage(pageB, url);
    await setCellInputCode(pageA, 0, "import time\ntime.sleep(4)\nprint('hi-sync')");
    await pageA.waitForTimeout(500);

    await clickRunButton(pageA, 0);
    await expect
      .poll(async () => await readRunButtonLabel(pageA, 0), {
        timeout: 45_000,
      })
      .toBe("Stop");

    await expect
      .poll(async () => await readRunButtonLabel(pageB, 0), {
        timeout: 45_000,
      })
      .toBe("Stop");

    await expect
      .poll(async () => await readInputExecCount(pageB, 0), {
        timeout: 35_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => await readRunButtonLabel(pageB, 0), {
        timeout: 20_000,
      })
      .toBe("Run");
  } finally {
    await context.close();
  }
});

test("queued cell state syncs across tabs", async ({ browser }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-queued-sync");
  await ensureNotebook(path_ipynb, [
    codeCell("import time\ntime.sleep(5)\nprint('first-done')"),
    codeCell("print('second-done')"),
  ]);
  const url = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
  });

  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await openNotebookPage(pageA, url);
    await openNotebookPage(pageB, url);
    await setCellInputCode(pageA, 0, "import time\ntime.sleep(5)\nprint('first-done')");
    await setCellInputCode(pageA, 1, "print('second-done')");
    await pageA.waitForTimeout(500);

    await clickRunButton(pageA, 0);
    await expect
      .poll(async () => await readRunButtonLabel(pageA, 0), {
        timeout: 45_000,
      })
      .toBe("Stop");
    await expect
      .poll(async () => await readRunButtonLabel(pageB, 0), {
        timeout: 45_000,
      })
      .toBe("Stop");

    await pageA.waitForTimeout(400);
    await clickRunButton(pageA, 1);

    await expect
      .poll(async () => await readRunButtonLabel(pageB, 1), {
        timeout: 15_000,
      })
      .toBe("Stop");

    await expect
      .poll(async () => await readInputExecCount(pageB, 1), {
        timeout: 40_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => await readRunButtonLabel(pageB, 1), {
        timeout: 20_000,
      })
      .toBe("Run");
  } finally {
    await context.close();
  }
});

test("reads metadata.cocalc.last_runtime_ms and shows it in UI", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-last-runtime-metadata");
  await ensureNotebook(path_ipynb, [
    codeCell("pass", {
      metadata: {
        cocalc: {
          last_runtime_ms: 2000,
        },
      },
    }),
  ]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  await expect
    .poll(async () => await readCellText(page, 0), {
      timeout: 12_000,
    })
    .toContain("2s");
});
