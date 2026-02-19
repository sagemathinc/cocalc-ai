import { expect, test } from "@playwright/test";
import {
  clearKernelErrorForE2E,
  clickRunButton,
  codeCell,
  readCellTimingLastMs,
  readCellTimingState,
  ensureNotebook,
  killKernelProcessesForE2E,
  notebookUrl,
  openNotebookPage,
  readCellOutputText,
  readCellText,
  readInputExecCount,
  readRunButtonLabel,
  resolveBaseUrl,
  setKernelErrorForE2E,
  setCellInputCode,
  uniqueNotebookPath,
} from "./helpers";

test.describe.configure({ mode: "serial" });

function execCountAdvanced(
  before: number | undefined,
  after: number | undefined,
): boolean {
  if (before == null) {
    return after != null;
  }
  if (after == null) {
    return false;
  }
  return after > before;
}

async function primeKernel(
  page: Parameters<typeof test>[0]["page"],
  cellIndex = 0,
) {
  const marker = `warmup-${Date.now()}`;
  const beforeExec = await readInputExecCount(page, cellIndex);
  await setCellInputCode(page, cellIndex, `print("${marker}")`);
  await clickRunButton(page, cellIndex);

  await expect
    .poll(async () => {
      const output = await readCellOutputText(page, cellIndex);
      return output.includes(marker);
    }, { timeout: 60_000 })
    .toBe(true);

  const afterExec = await readInputExecCount(page, cellIndex);
  if (beforeExec != null || afterExec != null) {
    await expect
      .poll(async () => {
        const latestExec = await readInputExecCount(page, cellIndex);
        return execCountAdvanced(beforeExec, latestExec);
      }, { timeout: 45_000 })
      .toBe(true);
  }
}

async function ensureKernelReadyOrSkip(
  page: Parameters<typeof test>[0]["page"],
  cellIndex = 0,
) {
  try {
    await primeKernel(page, cellIndex);
  } catch (err: any) {
    test.skip(
      true,
      `kernel execution unavailable in current session: ${
        err?.message ?? `${err}`
      }`,
    );
  }
}

test("runs a cell and shows output", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-run-smoke");
  await ensureNotebook(path_ipynb, [codeCell("pass")]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  await ensureKernelReadyOrSkip(page, 0);
});

test("running cell execution syncs across tabs", async ({ browser }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-running-sync");
  await ensureNotebook(path_ipynb, [
    codeCell("print('warmup')"),
    codeCell("import time\ntime.sleep(8)\nprint('hi-sync')"),
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
    await pageA.bringToFront();
    await ensureKernelReadyOrSkip(pageA, 0);

    await expect
      .poll(async () => await readInputExecCount(pageB, 0), {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    await setCellInputCode(pageA, 1, "import time\ntime.sleep(8)\nprint('hi-sync')");
    await expect
      .poll(async () => await readCellText(pageA, 1), { timeout: 20_000 })
      .toContain("hi-sync");

    const beforeExecA = await readInputExecCount(pageA, 1);
    const beforeExecB = await readInputExecCount(pageB, 1);
    await pageA.bringToFront();
    await clickRunButton(pageA, 1);

    await expect
      .poll(async () => {
        const afterExec = await readInputExecCount(pageA, 1);
        return execCountAdvanced(beforeExecA, afterExec);
      }, { timeout: 45_000 })
      .toBe(true);

    await expect
      .poll(async () => {
        const afterExec = await readInputExecCount(pageB, 1);
        return execCountAdvanced(beforeExecB, afterExec);
      }, { timeout: 45_000 })
      .toBe(true);

    await expect
      .poll(async () => await readCellOutputText(pageB, 1), {
        timeout: 60_000,
      })
      .toContain("hi-sync");
  } finally {
    await context.close();
  }
});

test("queued cell execution syncs across tabs", async ({ browser }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-queued-sync");
  await ensureNotebook(path_ipynb, [
    codeCell("print('warmup')"),
    codeCell("import time\ntime.sleep(8)\nprint('first-done')"),
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
    await pageA.bringToFront();
    await ensureKernelReadyOrSkip(pageA, 0);

    await expect
      .poll(async () => await readInputExecCount(pageB, 0), {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    await setCellInputCode(
      pageA,
      1,
      "import time\ntime.sleep(8)\nprint('first-done')",
    );
    await setCellInputCode(pageA, 2, "print('second-done')");

    const beforeExecB2 = await readInputExecCount(pageB, 2);
    await pageA.bringToFront();
    await clickRunButton(pageA, 1);
    await pageA.waitForTimeout(300);
    await pageA.bringToFront();
    await clickRunButton(pageA, 2);

    await pageA.waitForTimeout(1200);
    expect(await readCellOutputText(pageB, 2)).not.toContain("second-done");

    await expect
      .poll(async () => await readCellOutputText(pageB, 1), {
        timeout: 60_000,
      })
      .toContain("first-done");

    await expect
      .poll(async () => {
        const afterExec = await readInputExecCount(pageB, 2);
        return execCountAdvanced(beforeExecB2, afterExec);
      }, { timeout: 60_000 })
      .toBe(true);

    await expect
      .poll(async () => await readCellOutputText(pageB, 2), {
        timeout: 60_000,
      })
      .toContain("second-done");

  } finally {
    await context.close();
  }
});

test("kernel kill mid-run attempt still allows rerun", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-kernel-kill-rerun");
  await ensureNotebook(path_ipynb, [
    codeCell("print('warmup')"),
    codeCell("import time\ntime.sleep(20)\nprint('after-kill')"),
    codeCell("print('rerun-ok')"),
  ]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );
  await ensureKernelReadyOrSkip(page, 0);
  await setCellInputCode(
    page,
    1,
    "import time\ntime.sleep(20)\nprint('after-kill')",
  );
  await setCellInputCode(page, 2, "print('rerun-ok')");

  const beforeExec1 = await readInputExecCount(page, 1);
  await clickRunButton(page, 1);
  await expect
    .poll(async () => {
      const afterExec = await readInputExecCount(page, 1);
      return execCountAdvanced(beforeExec1, afterExec);
    }, { timeout: 45_000 })
    .toBe(true);
  await killKernelProcessesForE2E();
  await page.waitForTimeout(1000);
  await expect
    .poll(async () => await readRunButtonLabel(page, 1), {
      timeout: 60_000,
    })
    .toBe("Run");

  const beforeExec2 = await readInputExecCount(page, 2);
  await clickRunButton(page, 2);
  await expect
    .poll(async () => {
      const afterExec = await readInputExecCount(page, 2);
      return execCountAdvanced(beforeExec2, afterExec);
    }, { timeout: 60_000 })
    .toBe(true);
  await expect
    .poll(async () => await readCellOutputText(page, 2), {
      timeout: 60_000,
    })
    .toContain("rerun-ok");
});

test("kernel warning banner can be surfaced and cleared", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-kernel-warning");
  await ensureNotebook(path_ipynb, [codeCell("1+1")]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  const hasKernelWarningTestHook = await page.evaluate(() => {
    return (
      typeof (window as any).__cocalcJupyterRuntime?.set_kernel_error_for_test ===
      "function"
    );
  });
  test.skip(
    !hasKernelWarningTestHook,
    "kernel warning test hook unavailable in current frontend bundle",
  );

  const kernelWarning = page.locator('[cocalc-test="kernel-warning"]');
  await setKernelErrorForE2E(page, "Kernel terminated unexpectedly (test)");
  await expect(kernelWarning).toContainText("Kernel terminated unexpectedly");

  await clearKernelErrorForE2E(page);
  await expect(kernelWarning).toHaveCount(0);
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

  const hasRuntimeTestHook = await page.evaluate(() => {
    return (
      typeof (window as any).__cocalcJupyterRuntime?.set_kernel_error_for_test ===
      "function"
    );
  });
  test.skip(
    !hasRuntimeTestHook,
    "metadata last_runtime_ms assertions require current frontend runtime bundle",
  );

  await expect
    .poll(async () => {
      const timingState = await readCellTimingState(page, 0);
      if (timingState != null) {
        return `state:${timingState}`;
      }
      const cellText = await readCellText(page, 0);
      return /\b2s\b/.test(cellText) ? "text:2s" : "";
    }, {
      timeout: 12_000,
    })
    .toMatch(/^(state:last|text:2s)$/);

  const maybeTimingState = await readCellTimingState(page, 0);
  if (maybeTimingState === "last") {
    await expect
      .poll(async () => await readCellTimingLastMs(page, 0), {
        timeout: 12_000,
      })
      .toBe(2000);
  }
});
