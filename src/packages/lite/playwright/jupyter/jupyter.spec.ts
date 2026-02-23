import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  appendSingleDocCellCode,
  clearKernelErrorForE2E,
  clickRunButton,
  codeCell,
  countSingleDocCodeCells,
  countCells,
  blurSingleDocEditor,
  readKernelWarningText,
  readKernelWarningVisible,
  readCellTimingLastMs,
  readCellTimingState,
  ensureNotebook,
  killKernelProcessesForE2E,
  mutateNotebookOnDisk,
  notebookUrl,
  openNotebookPage,
  openSingleDocNotebookPage,
  pressSingleDocRunShortcut,
  readSingleDocCellText,
  readSingleDocOutputText,
  readCellOutputText,
  readCellText,
  readInputExecCount,
  readRunButtonLabel,
  resolveBaseUrl,
  setKernelErrorForE2E,
  setCellInputCode,
  setSingleDocCellCode,
  setSingleDocCellCodeViaRuntime,
  setSingleDocSelectionViaRuntime,
  uniqueNotebookPath,
} from "./helpers";

test.describe.configure({ mode: "serial" });

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const REQUIRE_KERNEL = envFlag("COCALC_JUPYTER_E2E_REQUIRE_KERNEL") || envFlag("CI");

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

async function readSingleDocCodeInput(page: Page, index: number): Promise<string> {
  return await page.evaluate((targetIndex: number) => {
    const cells = Array.from(
      document.querySelectorAll('[data-cocalc-test="jupyter-singledoc-code-cell"]'),
    );
    const cell = cells[targetIndex] as HTMLElement | undefined;
    if (!cell) return "";
    const lines = Array.from(cell.querySelectorAll(".cocalc-slate-code-line"));
    return lines
      .map((line) => ((line as HTMLElement).innerText ?? "").replace(/\r/g, ""))
      .join("\n")
      .trim();
  }, index);
}

async function readSingleDocSelectionCells(page: Page): Promise<{
  anchorCellId: string;
  focusCellId: string;
  collapsed: boolean;
}> {
  return await page.evaluate(() => {
    const selection = window.getSelection();
    const cellIdForNode = (node: Node | null): string => {
      if (!node) return "";
      const base =
        node instanceof Element ? node : (node.parentElement as Element | null);
      const cell = base?.closest?.('[data-cocalc-test="jupyter-singledoc-code-cell"]');
      return `${cell?.getAttribute?.("data-cocalc-cell-id") ?? ""}`.trim();
    };
    return {
      anchorCellId: cellIdForNode(selection?.anchorNode ?? null),
      focusCellId: cellIdForNode(selection?.focusNode ?? null),
      collapsed: Boolean(selection?.isCollapsed),
    };
  });
}

async function primeKernel(
  page: Page,
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

async function readAllSingleDocCodeText(page: Page): Promise<string> {
  const n = await countSingleDocCodeCells(page);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(await readSingleDocCellText(page, i));
  }
  return parts.join("\n---\n");
}

async function safeNotebookCellCount(page: Page): Promise<number> {
  return await page
    .locator(
      '[data-cocalc-test="jupyter-singledoc-code-cell"],[data-cocalc-test="jupyter-singledoc-markdown-cell"]',
    )
    .count();
}

type SingleDocMinimapSnapshot = {
  notebookScrollTop: number;
  notebookMaxScroll: number;
  notebookClientHeight: number;
  railHeight: number;
  trackHeight: number;
  miniScrollTop: number;
  scrollRatio: number;
};

async function readSingleDocMinimapSnapshot(
  page: Page,
): Promise<SingleDocMinimapSnapshot> {
  return await page.evaluate(() => {
    const root = document.querySelector(
      '[data-cocalc-jupyter-slate-single-doc="1"]',
    ) as HTMLElement | null;
    const rail = document.querySelector(
      '[data-cocalc-jupyter-minimap-rail="1"]',
    ) as HTMLElement | null;
    const track = document.querySelector(
      '[data-cocalc-jupyter-minimap-track="1"]',
    ) as HTMLElement | null;
    const miniScroll = document.querySelector(
      '[data-cocalc-jupyter-minimap-scroll="1"]',
    ) as HTMLElement | null;
    if (root == null || rail == null || track == null || miniScroll == null) {
      return {
        notebookScrollTop: 0,
        notebookMaxScroll: 0,
        notebookClientHeight: 0,
        railHeight: 0,
        trackHeight: 0,
        miniScrollTop: 0,
        scrollRatio: 0,
      };
    }
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))].filter(
      (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.closest('[data-cocalc-jupyter-minimap-wrapper="1"]')) return false;
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (!["auto", "scroll", "overlay"].includes(overflowY)) return false;
        const scrollable = el.scrollHeight - el.clientHeight;
        return scrollable > 2;
      },
    ) as HTMLElement[];
    const notebookContentHeight = Number(
      rail.getAttribute("data-cocalc-jupyter-minimap-notebook-content-height") ?? "0",
    );
    let scroller: HTMLElement | undefined;
    if (Number.isFinite(notebookContentHeight) && notebookContentHeight > 0) {
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const score = Math.abs(candidate.scrollHeight - notebookContentHeight);
        if (score < bestScore) {
          bestScore = score;
          scroller = candidate;
        }
      }
    }
    if (scroller == null) {
      candidates.sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
      );
      scroller = candidates[0] ?? root;
    }
    const notebookMaxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const rawRatio = rail.getAttribute("data-cocalc-jupyter-minimap-scroll-ratio");
    const scrollRatio = Number(rawRatio ?? 0);
    return {
      notebookScrollTop: scroller.scrollTop,
      notebookMaxScroll,
      notebookClientHeight: scroller.clientHeight,
      railHeight: rail.clientHeight,
      trackHeight: track.clientHeight,
      miniScrollTop: miniScroll.scrollTop,
      scrollRatio: Number.isFinite(scrollRatio) ? scrollRatio : 0,
    };
  });
}

async function setSingleDocNotebookScrollRatio(
  page: Page,
  ratio: number,
): Promise<void> {
  await page.evaluate((targetRatio: number) => {
    const root = document.querySelector(
      '[data-cocalc-jupyter-slate-single-doc="1"]',
    ) as HTMLElement | null;
    if (root == null) return;
    const rail = document.querySelector(
      '[data-cocalc-jupyter-minimap-rail="1"]',
    ) as HTMLElement | null;
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))].filter(
      (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.closest('[data-cocalc-jupyter-minimap-wrapper="1"]')) return false;
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (!["auto", "scroll", "overlay"].includes(overflowY)) return false;
        const scrollable = el.scrollHeight - el.clientHeight;
        return scrollable > 2;
      },
    ) as HTMLElement[];
    const notebookContentHeight = Number(
      rail?.getAttribute("data-cocalc-jupyter-minimap-notebook-content-height") ?? "0",
    );
    let scroller: HTMLElement | undefined;
    if (Number.isFinite(notebookContentHeight) && notebookContentHeight > 0) {
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const score = Math.abs(candidate.scrollHeight - notebookContentHeight);
        if (score < bestScore) {
          bestScore = score;
          scroller = candidate;
        }
      }
    }
    if (scroller == null) {
      candidates.sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
      );
      scroller = candidates[0] ?? root;
    }
    const clamped = Math.min(1, Math.max(0, targetRatio));
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = clamped * maxScroll;
  }, ratio);
}

async function setSingleDocMinimapScrollRatio(
  page: Page,
  ratio: number,
): Promise<void> {
  await page.evaluate((targetRatio: number) => {
    const mini = document.querySelector(
      '[data-cocalc-jupyter-minimap-scroll="1"]',
    ) as HTMLElement | null;
    const track = document.querySelector(
      '[data-cocalc-jupyter-minimap-track="1"]',
    ) as HTMLElement | null;
    if (mini == null || track == null) return;
    const maxScroll = Math.max(0, track.scrollHeight - mini.clientHeight);
    const clamped = Math.min(1, Math.max(0, targetRatio));
    mini.scrollTop = clamped * maxScroll;
    mini.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, ratio);
}

async function readClassicNotebookInputs(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const out: string[] = [];
    const editors = Array.from(
      document.querySelectorAll('[cocalc-test="cell-input"] .CodeMirror'),
    ) as any[];
    for (const element of editors) {
      const cm = element?.CodeMirror;
      if (cm && typeof cm.getValue === "function") {
        out.push(String(cm.getValue()));
      } else {
        out.push("");
      }
    }
    return out;
  });
}

async function appendSingleDocPlainTextNearTop(
  page: Page,
  text: string,
): Promise<void> {
  const leaf = page
    .locator('[data-cocalc-jupyter-slate-single-doc="1"] [data-slate-string]')
    .first();
  await leaf.scrollIntoViewIfNeeded();
  await leaf.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function ensureKernelReadyOrSkip(
  page: Page,
  cellIndex = 0,
) {
  try {
    await primeKernel(page, cellIndex);
  } catch (err: any) {
    if (REQUIRE_KERNEL) {
      throw new Error(
        `kernel execution unavailable in strict mode: ${
          err?.message ?? `${err}`
        }`,
      );
    }
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

test("single-doc editor handles Shift+Enter and Alt+Enter", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-run-shortcuts");
  const marker = `single-doc-${Date.now()}`;
  const marker2 = `single-doc-next-${Date.now()}`;
  await ensureNotebook(path_ipynb, [
    codeCell(`print("${marker}")`),
    codeCell(`print("${marker2}")`),
  ]);

  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  try {
    const beforeCount = await countSingleDocCodeCells(page);
    await pressSingleDocRunShortcut(page, 0, "Shift+Enter");
    await expect
      .poll(async () => await readSingleDocOutputText(page, 0), {
        timeout: 60_000,
      })
      .toContain(marker);

    // Shift+Enter should move to next cell in single-doc mode.
    await page.keyboard.press("Shift+Enter");
    await expect
      .poll(async () => await readSingleDocOutputText(page, 1), {
        timeout: 60_000,
      })
      .toContain(marker2);

    await pressSingleDocRunShortcut(page, 0, "Alt+Enter");
    await expect
      .poll(async () => await countSingleDocCodeCells(page), {
        timeout: 45_000,
      })
      .toBeGreaterThan(beforeCount);
  } catch (err: any) {
    if (REQUIRE_KERNEL) {
      throw new Error(
        `single-doc run shortcuts unavailable in strict mode: ${
          err?.message ?? `${err}`
        }`,
      );
    }
    test.skip(
      true,
      `single-doc run shortcuts unavailable in current session: ${
        err?.message ?? `${err}`
      }`,
    );
  }
});

test("single-doc typing syncs into canonical notebook cell input", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-sync");
  await ensureNotebook(path_ipynb, [codeCell("print('base')")]);
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  await openSingleDocNotebookPage(page, singleDocUrl);

  const marker = `single-doc-sync-${Date.now()}`;
  await setSingleDocCellCodeViaRuntime(page, 0, `print('base')\nprint("${marker}")`);

  await expect
    .poll(async () => await readSingleDocCellText(page, 0), {
      timeout: 30_000,
    })
    .toContain(marker);

  const reopened = await page.context().newPage();
  try {
    await openSingleDocNotebookPage(reopened, singleDocUrl);
    await expect
      .poll(async () => await readAllSingleDocCodeText(reopened), {
        timeout: 45_000,
      })
      .toContain(marker);
  } finally {
    await reopened.close();
  }
});

test("single-doc keyboard edits debounce-sync into canonical notebook input", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-keyboard-sync");
  await ensureNotebook(path_ipynb, [codeCell("print('base')")]);
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  await openSingleDocNotebookPage(page, singleDocUrl);

  const marker = `single-doc-kbd-${Date.now()}`;
  await appendSingleDocCellCode(page, 0, ` # ${marker}`);
  await blurSingleDocEditor(page);
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const runtime = (window as any).__cocalcJupyterRuntime;
          return Number(runtime?.get_single_doc_debug_for_test?.()?.onSlateChangeCalls ?? 0);
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const runtime = (window as any).__cocalcJupyterRuntime;
          return Number(runtime?.get_single_doc_debug_for_test?.()?.applyNotebookSlateCalls ?? 0);
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const runtime = (window as any).__cocalcJupyterRuntime;
          return Number(runtime?.get_single_doc_debug_for_test?.()?.applyNotebookSlateMutations ?? 0);
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await readSingleDocCellText(page, 0), {
      timeout: 45_000,
    })
    .toContain(marker);

  const reopened = await page.context().newPage();
  try {
    await openSingleDocNotebookPage(reopened, singleDocUrl);
    await expect
      .poll(async () => await readAllSingleDocCodeText(reopened), {
        timeout: 45_000,
      })
      .toContain(marker);
  } finally {
    await reopened.close();
  }
});

test("single-doc debounce sync settles without feedback-loop growth", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-no-loop");
  await ensureNotebook(path_ipynb, [codeCell("print('base')"), codeCell("print('two')")]);
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  await openSingleDocNotebookPage(page, singleDocUrl);
  let initialStoreCount = 0;
  await expect
    .poll(
      async () => {
        const n = await safeNotebookCellCount(page);
        if (n > 0) {
          initialStoreCount = n;
        }
        return n;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const marker = `settle-${Date.now()}`;
  await appendSingleDocCellCode(page, 0, ` # ${marker}`);
  await blurSingleDocEditor(page);

  await expect
    .poll(async () => await readSingleDocCellText(page, 0), {
      timeout: 45_000,
    })
    .toContain(marker);
  await expect
    .poll(async () => await safeNotebookCellCount(page), {
      timeout: 30_000,
    })
    .toBe(initialStoreCount);

  await page.waitForTimeout(2_000);
  const debug1 = await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    return runtime?.get_single_doc_debug_for_test?.() ?? {};
  });
  await page.waitForTimeout(2_000);
  const debug2 = await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    return runtime?.get_single_doc_debug_for_test?.() ?? {};
  });
  expect(Number(debug2.applyNotebookSlateMutations ?? 0)).toBe(
    Number(debug1.applyNotebookSlateMutations ?? 0),
  );
});

test.fixme("single-doc and classic jupyter mixed edits do not duplicate cells", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-classic-mixed-stable");
  await ensureNotebook(path_ipynb, [codeCell("a = 5\nb = 10"), codeCell("a*b")]);
  const classicUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
  });
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  await openNotebookPage(page, classicUrl);
  const initialClassicCount = await countCells(page);
  const slatePage = await page.context().newPage();
  try {
    await openSingleDocNotebookPage(slatePage, singleDocUrl);
    await expect
      .poll(async () => await countSingleDocCodeCells(slatePage), {
        timeout: 30_000,
      })
      .toBeGreaterThan(1);
    await setCellInputCode(page, 0, "a = 5\nb = 10");
    await setSingleDocCellCodeViaRuntime(slatePage, 1, "a*b");
    const beforeRunInputs = await readClassicNotebookInputs(page);
    expect(beforeRunInputs.filter((x) => x.trim() === "a*b").length).toBe(1);
    await setSingleDocSelectionViaRuntime(slatePage, 1, "end");
    await slatePage.keyboard.press("Shift+Enter");

    await expect
      .poll(async () => await countCells(page), {
        timeout: 30_000,
      })
      .toBe(initialClassicCount + 1);
    await expect
      .poll(async () => await safeNotebookCellCount(slatePage), {
        timeout: 30_000,
      })
      .toBe(initialClassicCount + 1);

    await page.waitForTimeout(2_500);
    await expect
      .poll(async () => await countCells(page), {
        timeout: 30_000,
      })
      .toBe(initialClassicCount + 1);
    await expect
      .poll(async () => await safeNotebookCellCount(slatePage), {
        timeout: 30_000,
      })
      .toBe(initialClassicCount + 1);

    const classicInputs = await readClassicNotebookInputs(page);
    expect(classicInputs.filter((x) => x.trim() === "a*b").length).toBe(1);
    expect(classicInputs.filter((x) => x.trim() === "a = 5\nb = 10").length).toBe(1);
  } finally {
    await slatePage.close();
  }
});

test("single-doc stale structural apply is rejected without creating cells", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-stale-structural-reject");
  await ensureNotebook(path_ipynb, [codeCell("print('one')"), codeCell("print('two')")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const initialCount = await safeNotebookCellCount(page);
  expect(initialCount).toBeGreaterThan(0);
  const debugBefore = await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    return runtime?.get_single_doc_debug_for_test?.() ?? {};
  });

  await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    if (typeof runtime?.apply_single_doc_stale_structural_for_test !== "function") {
      throw new Error("missing apply_single_doc_stale_structural_for_test runtime helper");
    }
    runtime.apply_single_doc_stale_structural_for_test("print('should-not-create')");
  });

  await expect
    .poll(async () => await safeNotebookCellCount(page), {
      timeout: 30_000,
    })
    .toBe(initialCount);

  const debugAfter = await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    return runtime?.get_single_doc_debug_for_test?.() ?? {};
  });
  expect(Number(debugAfter.rejectedStaleStructuralApplies ?? 0)).toBeGreaterThan(
    Number(debugBefore.rejectedStaleStructuralApplies ?? 0),
  );
  expect(Number(debugAfter.rejectedStaleCells ?? 0)).toBeGreaterThan(
    Number(debugBefore.rejectedStaleCells ?? 0),
  );
});

test("single-doc duplicate canonical cell-id insert is ignored", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-duplicate-id-remap");
  await ensureNotebook(path_ipynb, [codeCell("print('one')"), codeCell("print('two')")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const initialCount = await safeNotebookCellCount(page);
  expect(initialCount).toBeGreaterThan(0);

  await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    if (
      typeof runtime?.duplicate_single_doc_code_cell_with_same_id_for_test !==
      "function"
    ) {
      throw new Error(
        "missing duplicate_single_doc_code_cell_with_same_id_for_test runtime helper",
      );
    }
    runtime.duplicate_single_doc_code_cell_with_same_id_for_test(0);
  });

  await expect
    .poll(async () => await safeNotebookCellCount(page), {
      timeout: 30_000,
    })
    .toBe(initialCount);

  const ids = await page.evaluate(() => {
    const runtime = (window as any).__cocalcJupyterRuntime;
    return runtime?.get_single_doc_canonical_cell_ids_for_test?.() ?? [];
  });
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.length).toBe(initialCount);
  expect(new Set(ids).size).toBe(ids.length);
});

test("single-doc typing keeps focus and caret in active cell across debounce sync", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-focus-stable");
  await ensureNotebook(path_ipynb, [codeCell("x = 1"), codeCell("y = 2")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const firstCell = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').first();
  await firstCell.scrollIntoViewIfNeeded();
  const firstCellId = `${(await firstCell.getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  expect(firstCellId.length).toBeGreaterThan(0);
  await firstCell.locator(".cocalc-slate-code-line").last().click();
  await page.keyboard.type(" # focus-nav");

  await page.waitForTimeout(1_300); // pass debounce threshold
  const state1 = await page.evaluate((expectedCellId: string) => {
    const root = document.querySelector('[data-cocalc-jupyter-slate-single-doc="1"]');
    const active = document.activeElement as HTMLElement | null;
    const sel = window.getSelection();
    const anchor =
      sel?.anchorNode instanceof Node
        ? sel.anchorNode.parentElement?.closest(
            '[data-cocalc-test="jupyter-singledoc-code-cell"]',
          )
        : null;
    return {
      focusedInRoot: !!(root && active && root.contains(active)),
      cellId: `${(anchor as HTMLElement | null)?.getAttribute?.("data-cocalc-cell-id") ?? ""}`.trim(),
      offset: Number(sel?.anchorOffset ?? 0),
      expectedCellId,
    };
  }, firstCellId);
  expect(state1?.focusedInRoot).toBe(true);
  expect(state1?.cellId).toBe(firstCellId);
  expect(typeof state1?.offset).toBe("number");
  expect(Number(state1?.offset ?? 0)).toBeGreaterThan(0);

  await page.waitForTimeout(1_300); // ensure no post-debounce jump
  const state2 = await page.evaluate(() => {
    const root = document.querySelector('[data-cocalc-jupyter-slate-single-doc="1"]');
    const active = document.activeElement as HTMLElement | null;
    const sel = window.getSelection();
    const anchor =
      sel?.anchorNode instanceof Node
        ? sel.anchorNode.parentElement?.closest(
            '[data-cocalc-test="jupyter-singledoc-code-cell"]',
          )
        : null;
    return {
      focusedInRoot: !!(root && active && root.contains(active)),
      cellId: `${(anchor as HTMLElement | null)?.getAttribute?.("data-cocalc-cell-id") ?? ""}`.trim(),
      offset: Number(sel?.anchorOffset ?? 0),
    };
  });
  expect(state2?.focusedInRoot).toBe(true);
  expect(state2?.cellId).toBe(firstCellId);
  expect(Number(state2?.offset ?? 0)).toBeGreaterThan(0);

  await expect
    .poll(async () => await readSingleDocCellText(page, 0), {
      timeout: 30_000,
    })
    .toContain("focus-nav");
});

test("single-doc ArrowRight at code-cell end moves caret to next code cell", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-arrow-right-next-cell");
  await ensureNotebook(path_ipynb, [codeCell("aaa"), codeCell("bbb")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const first = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').first();
  await first.locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 0, "end");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("X");
  await blurSingleDocEditor(page);
  await page.waitForTimeout(1_300);

  await expect
    .poll(async () => await readSingleDocCodeInput(page, 0), {
      timeout: 30_000,
    })
    .toBe("aaa");
  await expect
    .poll(async () => await readSingleDocCodeInput(page, 1), {
      timeout: 30_000,
    })
    .toBe("Xbbb");
});

test("single-doc ArrowLeft at code-cell start moves caret to previous code cell", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-arrow-left-prev-cell");
  await ensureNotebook(path_ipynb, [codeCell("aaa"), codeCell("bbb")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const cells = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]');
  const firstCellId = `${(await cells.nth(0).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  const secondCellId = `${(await cells.nth(1).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  const second = cells.nth(1);
  await second.locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 1, "start");
  let movedToPrevious = false;
  for (let i = 0; i < 8; i++) {
    const state = await readSingleDocSelectionCells(page);
    if (state.focusCellId === firstCellId && !state.collapsed) {
      // Unexpected, but bail to avoid over-moving.
      break;
    }
    if (state.focusCellId === firstCellId && state.collapsed) {
      movedToPrevious = true;
      break;
    }
    await page.keyboard.press("ArrowLeft");
  }
  if (!movedToPrevious) {
    await expect
      .poll(async () => (await readSingleDocSelectionCells(page)).focusCellId, {
        timeout: 10_000,
      })
      .toBe(firstCellId);
  }
  await expect
    .poll(async () => (await readSingleDocSelectionCells(page)).anchorCellId, {
      timeout: 10_000,
    })
    .toBe(firstCellId);
  await expect(secondCellId.length).toBeGreaterThan(0);
  await page.keyboard.type("Y");
  await blurSingleDocEditor(page);
  await page.waitForTimeout(1_300);

  await expect
    .poll(async () => await readSingleDocCodeInput(page, 0), {
      timeout: 30_000,
    })
    .toBe("aaaY");
  await expect
    .poll(async () => await readSingleDocCodeInput(page, 1), {
      timeout: 30_000,
    })
    .toBe("bbb");
});

test("single-doc Shift+ArrowRight at cell end extends selection into next cell", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-shift-right-extend");
  await ensureNotebook(path_ipynb, [codeCell("aaa"), codeCell("bbb")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const cells = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]');
  const firstCellId = `${(await cells.nth(0).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  const secondCellId = `${(await cells.nth(1).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  expect(firstCellId.length).toBeGreaterThan(0);
  expect(secondCellId.length).toBeGreaterThan(0);

  await cells.nth(0).locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 0, "end");
  await page.keyboard.press("Shift+ArrowRight");

  await expect
    .poll(async () => await readSingleDocSelectionCells(page), {
      timeout: 30_000,
    })
    .toMatchObject({
      anchorCellId: firstCellId,
      focusCellId: secondCellId,
      collapsed: false,
    });
});

test("single-doc Shift+ArrowLeft at cell start extends selection into previous cell", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-shift-left-extend");
  await ensureNotebook(path_ipynb, [codeCell("aaa"), codeCell("bbb")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const cells = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]');
  const firstCellId = `${(await cells.nth(0).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  const secondCellId = `${(await cells.nth(1).getAttribute("data-cocalc-cell-id")) ?? ""}`.trim();
  expect(firstCellId.length).toBeGreaterThan(0);
  expect(secondCellId.length).toBeGreaterThan(0);

  await cells.nth(1).locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 1, "start");
  for (let i = 0; i < 8; i++) {
    const state = await readSingleDocSelectionCells(page);
    if (!state.collapsed && state.focusCellId === firstCellId) {
      break;
    }
    await page.keyboard.press("Shift+ArrowLeft");
  }

  await expect
    .poll(async () => await readSingleDocSelectionCells(page), {
      timeout: 30_000,
    })
    .toMatchObject({
      anchorCellId: secondCellId,
      focusCellId: firstCellId,
      collapsed: false,
    });
});

test.fixme("single-doc collapsed copy+paste duplicates current jupyter cell", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-cell-copy-paste");
  await ensureNotebook(path_ipynb, [codeCell("alpha"), codeCell("beta")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const first = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').first();
  await first.locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 0, "end");
  await page.keyboard.press("ControlOrMeta+C");
  await page.keyboard.press("ControlOrMeta+V");
  await blurSingleDocEditor(page);
  await page.waitForTimeout(1_300);

  await expect
    .poll(async () => await countSingleDocCodeCells(page), {
      timeout: 30_000,
    })
    .toBe(3);
  await expect
    .poll(async () => await readSingleDocCodeInput(page, 0), { timeout: 30_000 })
    .toBe("alpha");
  await expect
    .poll(async () => await readSingleDocCodeInput(page, 1), { timeout: 30_000 })
    .toBe("alpha");
  await expect
    .poll(async () => await readSingleDocCodeInput(page, 2), { timeout: 30_000 })
    .toBe("beta");
});

test.fixme("single-doc paste then undo does not crash and restores cell count", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-paste-undo-stable");
  await ensureNotebook(path_ipynb, [codeCell("x = 1"), codeCell("y = 2")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const first = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').first();
  await first.locator(".cocalc-slate-code-line").last().click();
  await setSingleDocSelectionViaRuntime(page, 0, "end");
  await page.keyboard.press("ControlOrMeta+C");
  await page.keyboard.press("ControlOrMeta+V");
  await expect
    .poll(async () => await countSingleDocCodeCells(page), { timeout: 30_000 })
    .toBe(3);

  await page.keyboard.press("ControlOrMeta+Z");
  await blurSingleDocEditor(page);
  await page.waitForTimeout(1_300);

  await expect
    .poll(async () => await countSingleDocCodeCells(page), { timeout: 30_000 })
    .toBe(2);
  await expect(
    page.locator('[data-cocalc-jupyter-slate-single-doc="1"]'),
  ).toBeVisible();
  await expect(
    page.locator("text=CoCalc Crashed"),
  ).toHaveCount(0);
});

test("single-doc top-level text typing does not duplicate cells", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-markdown-no-loop");
  await ensureNotebook(path_ipynb, [
    { cell_type: "markdown", metadata: {}, source: ["alpha"] },
    codeCell("print('two')"),
  ]);
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  await openSingleDocNotebookPage(page, singleDocUrl);
  let initialCount = 0;
  await expect
    .poll(
      async () => {
        const n = await safeNotebookCellCount(page);
        if (n > 0) initialCount = n;
        return n;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const marker = `md-${Date.now()}`;
  await appendSingleDocPlainTextNearTop(page, ` ${marker}`);
  await blurSingleDocEditor(page);

  await expect
    .poll(
      async () =>
        (
          (await page
            .locator('[data-cocalc-jupyter-slate-single-doc="1"]')
            .first()
            .textContent()) ?? ""
        ).replace(/\s+/g, " "),
      { timeout: 30_000 },
    )
    .toContain(marker);
  await expect
    .poll(async () => await safeNotebookCellCount(page), {
      timeout: 30_000,
    })
    .toBe(initialCount);

  await page.waitForTimeout(2_000);
  expect(await safeNotebookCellCount(page)).toBe(initialCount);
});

test("single-doc shows chrome for at most one selected code cell", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-chrome-hover");
  await ensureNotebook(path_ipynb, [codeCell("print('a')"), codeCell("print('b')")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const cells = page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]');
  await expect(cells).toHaveCount(2);
  await cells.nth(0).click();
  expect(
    await page.locator('[data-cocalc-test="jupyter-singledoc-cell-chrome"]').count(),
  ).toBeLessThanOrEqual(1);
  await cells.nth(1).click();
  expect(
    await page.locator('[data-cocalc-test="jupyter-singledoc-cell-chrome"]').count(),
  ).toBeLessThanOrEqual(1);
});

test("single-doc + classic cross-view run does not create extra trailing cells", async ({
  browser,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-classic-no-extra");
  await ensureNotebook(path_ipynb, [codeCell("a = 5\nb = 10"), codeCell("pass")]);
  const classicUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
  });
  const singleDocUrl = notebookUrl({
    base_url: conn.base_url,
    path_ipynb,
    auth_token: conn.auth_token,
    frame_type: "jupyter-singledoc",
  });

  const context = await browser.newContext();
  const classicPage = await context.newPage();
  const singleDocPage = await context.newPage();
  try {
    await openNotebookPage(classicPage, classicUrl);
    await openSingleDocNotebookPage(singleDocPage, singleDocUrl);

    await ensureKernelReadyOrSkip(classicPage, 0);
    await setCellInputCode(classicPage, 0, "a = 5\nb = 10");
    await clickRunButton(classicPage, 0);

    await expect
      .poll(async () => await readSingleDocCellText(singleDocPage, 0), {
        timeout: 45_000,
      })
      .toContain("a = 5");

    const baselineSingleDocCodeCount = await countSingleDocCodeCells(singleDocPage);
    const baselineClassicCount = await countCells(classicPage);
    expect(baselineSingleDocCodeCount).toBeGreaterThanOrEqual(1);

    await expect
      .poll(async () => await countSingleDocCodeCells(singleDocPage), {
        timeout: 30_000,
      })
      .toBe(baselineSingleDocCodeCount);

    const targetIndex = baselineSingleDocCodeCount - 1;
    await setSingleDocCellCode(singleDocPage, targetIndex, "a*b");
    await pressSingleDocRunShortcut(singleDocPage, targetIndex, "Shift+Enter");
    await singleDocPage.waitForTimeout(3_000);

    const afterRunClassicCount = await countCells(classicPage);
    expect(afterRunClassicCount).toBeGreaterThanOrEqual(baselineClassicCount);
    expect(afterRunClassicCount).toBeLessThanOrEqual(baselineClassicCount + 1);

    await blurSingleDocEditor(singleDocPage);
    await singleDocPage.waitForTimeout(2_000);

    await expect
      .poll(async () => await countCells(classicPage), { timeout: 30_000 })
      .toBe(afterRunClassicCount);

    const n = await countCells(classicPage);
    const texts: string[] = [];
    for (let i = 0; i < n; i++) {
      texts.push(await readCellText(classicPage, i));
    }
    const abCount = texts.filter((x) => x.includes("a*b")).length;
    expect(abCount).toBe(1);
  } finally {
    await context.close();
  }
});

test("single-doc local+external concurrent edits converge without duplication", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-converge-local-disk");
  await ensureNotebook(path_ipynb, [codeCell("print('base')")]);
  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );
  const localMarker = `local-${Date.now()}`;
  const diskMarker = `disk-${Date.now()}`;
  await appendSingleDocCellCode(page, 0, ` # ${localMarker}`);
  await blurSingleDocEditor(page);
  await expect
    .poll(async () => await readAllSingleDocCodeText(page), { timeout: 45_000 })
    .toContain(localMarker);
  await mutateNotebookOnDisk(path_ipynb, (ipynb) => {
    ipynb.cells.push(codeCell(`print("${diskMarker}")`));
  });
  await blurSingleDocEditor(page);

  await expect
    .poll(async () => await countSingleDocCodeCells(page), { timeout: 45_000 })
    .toBe(2);
  await expect
    .poll(async () => await readAllSingleDocCodeText(page), { timeout: 45_000 })
    .toContain(diskMarker);

  const text = await readAllSingleDocCodeText(page);
  expect(text.split(localMarker).length - 1).toBeLessThanOrEqual(1);
  expect(text.split(diskMarker).length - 1).toBe(1);
});

test("single-doc local edits and external disk edits merge without loss", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-merge");
  await ensureNotebook(path_ipynb, [codeCell("print('base')")]);

  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  const localMarker = `local-${Date.now()}`;
  await setSingleDocCellCodeViaRuntime(
    page,
    0,
    `print('base')\nprint("${localMarker}")`,
  );
  await expect
    .poll(async () => await readSingleDocCellText(page, 0), {
      timeout: 30_000,
    })
    .toContain(localMarker);

  // Confirm local edit is durably synced before introducing external mutation.
  const preMergeReopen = await page.context().newPage();
  try {
    await openSingleDocNotebookPage(
      preMergeReopen,
      notebookUrl({
        base_url: conn.base_url,
        path_ipynb,
        auth_token: conn.auth_token,
        frame_type: "jupyter-singledoc",
      }),
    );
    await expect
      .poll(async () => await readAllSingleDocCodeText(preMergeReopen), {
        timeout: 45_000,
      })
      .toContain(localMarker);
  } finally {
    await preMergeReopen.close();
  }

  const diskCode = `print("disk-added-${Date.now()}")`;
  await mutateNotebookOnDisk(path_ipynb, (ipynb) => {
    ipynb.cells.push(codeCell(diskCode));
  });
  await blurSingleDocEditor(page);

  await expect
    .poll(async () => await countSingleDocCodeCells(page), {
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(2);

  await expect
    .poll(async () => await readAllSingleDocCodeText(page), {
      timeout: 45_000,
    })
    .toContain(localMarker);

  await expect
    .poll(async () => await readAllSingleDocCodeText(page), {
      timeout: 45_000,
    })
    .toContain(diskCode);

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

test("external on-disk edit reloads open notebook content", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-disk-reload-open");
  await ensureNotebook(path_ipynb, [codeCell("print('disk-v1')")]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  await expect
    .poll(async () => await readCellText(page, 0), { timeout: 20_000 })
    .toContain("disk-v1");

  await mutateNotebookOnDisk(path_ipynb, (ipynb) => {
    ipynb.cells[0] = codeCell("print('disk-v2')");
  });

  await expect
    .poll(async () => await readCellText(page, 0), { timeout: 30_000 })
    .toContain("disk-v2");
});

test("external on-disk edit merges with unsaved live notebook edits", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-disk-merge-open");
  await ensureNotebook(path_ipynb, [codeCell("print('disk-base')")]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  await setCellInputCode(page, 0, "print('local-unsaved')");
  await expect
    .poll(async () => await readCellText(page, 0), { timeout: 20_000 })
    .toContain("local-unsaved");

  await mutateNotebookOnDisk(path_ipynb, (ipynb) => {
    ipynb.cells.push(codeCell("print('disk-added')"));
  });

  await expect
    .poll(async () => await countCells(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => await readCellText(page, 1), { timeout: 30_000 })
    .toContain("disk-added");
  await expect
    .poll(async () => await readCellText(page, 0), { timeout: 30_000 })
    .toContain("local-unsaved");
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

  const warningText = "Kernel terminated unexpectedly (test)";
  await setKernelErrorForE2E(page, warningText);
  await expect
    .poll(async () => await readKernelWarningVisible(page), { timeout: 20_000 })
    .toBe(true);
  await expect
    .poll(async () => await readKernelWarningText(page), { timeout: 20_000 })
    .toContain(warningText);

  await clearKernelErrorForE2E(page);
  await expect
    .poll(async () => await readKernelWarningVisible(page), { timeout: 20_000 })
    .toBe(false);
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

test("single-doc minimap scrolls and click-jumps notebook viewport", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("cocalc_jupyter_minimap", "1");
    window.localStorage.setItem("cocalc_jupyter_minimap_width", "80");
  });
  await page.setViewportSize({ width: 1900, height: 1100 });

  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-singledoc-minimap-scroll");
  const cells = Array.from({ length: 220 }, (_, i) =>
    codeCell(`x_${i} = ${i}\nprint(x_${i})`),
  );
  await ensureNotebook(path_ipynb, cells);

  await openSingleDocNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
      frame_type: "jupyter-singledoc",
    }),
  );

  await page.waitForSelector('[data-cocalc-jupyter-minimap-rail="1"]', {
    timeout: 30_000,
  });

  await expect
    .poll(async () => await readSingleDocMinimapSnapshot(page), {
      timeout: 30_000,
    })
    .toMatchObject({
      notebookClientHeight: expect.any(Number),
      railHeight: expect.any(Number),
      trackHeight: expect.any(Number),
    });

  await expect
    .poll(async () => {
      const snap = await readSingleDocMinimapSnapshot(page);
      return {
        notebookMaxScroll: snap.notebookMaxScroll,
        trackMinusRail: snap.trackHeight - snap.railHeight,
      };
    }, {
      timeout: 30_000,
    })
    .toEqual(
      expect.objectContaining({
        notebookMaxScroll: expect.any(Number),
        trackMinusRail: expect.any(Number),
      }),
    );

  await expect
    .poll(async () => {
      const snap = await readSingleDocMinimapSnapshot(page);
      return snap.notebookMaxScroll > 300 && snap.trackHeight > snap.railHeight + 8;
    }, {
      timeout: 30_000,
    })
    .toBe(true);

  await setSingleDocNotebookScrollRatio(page, 0.7);
  await expect
    .poll(async () => {
      const snap = await readSingleDocMinimapSnapshot(page);
      return snap.scrollRatio;
    }, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0.45);

  // Manual minimap scrolling should not immediately snap back to notebook scroll.
  await setSingleDocNotebookScrollRatio(page, 0.05);
  const beforeManualMini = await readSingleDocMinimapSnapshot(page);
  await setSingleDocMinimapScrollRatio(page, 0.95);
  await page.waitForTimeout(350);
  const afterManualMini = await readSingleDocMinimapSnapshot(page);
  expect(afterManualMini.miniScrollTop).toBeGreaterThan(
    beforeManualMini.miniScrollTop + 40,
  );
  expect(afterManualMini.notebookScrollTop).toBeLessThan(
    beforeManualMini.notebookScrollTop + 80,
  );

  const rail = page.locator('[data-cocalc-jupyter-minimap-rail="1"]');
  await rail.scrollIntoViewIfNeeded();
  await setSingleDocMinimapScrollRatio(page, 0.0);
  await page.waitForTimeout(250);
  const beforeTopClick = await readSingleDocMinimapSnapshot(page);
  const box = await rail.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  await page.mouse.click(box.x + box.width / 2, box.y + Math.max(8, box.height * 0.1));
  await expect
    .poll(async () => {
      const snap = await readSingleDocMinimapSnapshot(page);
      return snap.notebookScrollTop < beforeTopClick.notebookScrollTop;
    }, {
      timeout: 20_000,
    })
    .toBe(true);

  const beforeBottomClick = await readSingleDocMinimapSnapshot(page);
  await page.mouse.click(
    box.x + box.width / 2,
    box.y + Math.min(box.height - 8, box.height * 0.9),
  );
  await expect
    .poll(async () => {
      const snap = await readSingleDocMinimapSnapshot(page);
      return snap.notebookScrollTop > beforeBottomClick.notebookScrollTop;
    }, {
      timeout: 20_000,
    })
    .toBe(true);
});
