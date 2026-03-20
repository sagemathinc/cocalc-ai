import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  clickRunButton,
  codeCell,
  ensureNotebook,
  notebookUrl,
  openNotebookPage,
  readCellOutputText,
  readInputExecCount,
  readRunButtonLabel,
  resolveBaseUrl,
  setCellInputCode,
  uniqueNotebookPath,
  cellLocator,
} from "./helpers";

test.describe.configure({ mode: "serial" });

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const REQUIRE_KERNEL =
  envFlag("COCALC_JUPYTER_E2E_REQUIRE_KERNEL") || envFlag("CI");

const RERUN_CODE = 'for i in range(1000): print(i, end=" ")';
const REFRESH_CODE = [
  "from time import sleep",
  "for i in range(50):",
  '    print(i, end=" ")',
  "    sleep(0.1)",
].join("\n");
const WIDGET_CODE = [
  "from ipywidgets import interact",
  "@interact(x=10, y=True)",
  "def f(x, y):",
  "    return (x, y)",
].join("\n");

function normalizeOutput(text: string): string {
  return text
    .replace(/\bOut\s*\[\d+\]\s*:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForNotebookReloadReady(
  page: Page,
  timeoutMs: number = 20_000,
): Promise<void> {
  await page.waitForSelector('[cocalc-test="jupyter-cell"]', {
    timeout: timeoutMs,
  });
  await page.waitForSelector('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: timeoutMs,
  });
}

async function findCellIndexContaining(
  page: Page,
  needle: string,
  timeoutMs: number = 20_000,
): Promise<number> {
  await expect
    .poll(
      async () => {
        const count = await page
          .locator('[cocalc-test="jupyter-cell"]')
          .count();
        for (let i = 0; i < count; i += 1) {
          const text = await cellLocator(page, i).innerText();
          if (text.includes(needle)) {
            return i;
          }
        }
        return -1;
      },
      { timeout: timeoutMs },
    )
    .not.toBe(-1);

  const count = await page.locator('[cocalc-test="jupyter-cell"]').count();
  for (let i = 0; i < count; i += 1) {
    const text = await cellLocator(page, i).innerText();
    if (text.includes(needle)) {
      return i;
    }
  }
  throw new Error(`unable to find cell containing '${needle}'`);
}

async function waitForExecAdvance(
  page: Page,
  index: number,
  beforeExec: number | undefined,
  timeoutMs: number,
): Promise<number> {
  if (beforeExec == null) {
    await expect
      .poll(async () => await readInputExecCount(page, index), {
        timeout: timeoutMs,
      })
      .not.toBeUndefined();
    return (await readInputExecCount(page, index)) as number;
  }
  await expect
    .poll(async () => await readInputExecCount(page, index), {
      timeout: timeoutMs,
    })
    .toBe(beforeExec + 1);
  return beforeExec + 1;
}

async function runCellAndWait({
  page,
  index,
  timeoutMs = 60_000,
  outputMustContain,
  waitForRunButton = false,
}: {
  page: Page;
  index: number;
  timeoutMs?: number;
  outputMustContain?: string;
  waitForRunButton?: boolean;
}): Promise<number> {
  const beforeExec = await readInputExecCount(page, index);
  await clickRunButton(page, index);
  const nextExec = await waitForExecAdvance(page, index, beforeExec, timeoutMs);
  if (outputMustContain != null) {
    await expect
      .poll(
        async () => normalizeOutput(await readCellOutputText(page, index)),
        {
          timeout: timeoutMs,
        },
      )
      .toContain(outputMustContain);
  }
  if (waitForRunButton) {
    await expect
      .poll(async () => await readRunButtonLabel(page, index), {
        timeout: timeoutMs,
      })
      .toBe("Run");
  }
  return nextExec;
}

async function setCodeRunAndWait({
  page,
  index,
  code,
  timeoutMs = 60_000,
  outputMustContain,
  waitForRunButton = false,
}: {
  page: Page;
  index: number;
  code: string;
  timeoutMs?: number;
  outputMustContain?: string;
  waitForRunButton?: boolean;
}): Promise<number> {
  await setCellInputCode(page, index, code);
  return await runCellAndWait({
    page,
    index,
    timeoutMs,
    outputMustContain,
    waitForRunButton,
  });
}

async function ensureKernelReadyOrSkip(page: Page, index: number) {
  const marker = `warmup-${Date.now()}`;
  try {
    await setCodeRunAndWait({
      page,
      index,
      code: `print("${marker}")`,
      outputMustContain: marker,
    });
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

async function waitForOutputExact(
  page: Page,
  index: number,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(async () => normalizeOutput(await readCellOutputText(page, index)), {
      timeout: timeoutMs,
    })
    .toBe(expected);
}

async function widgetSlider(page: Page, index: number): Promise<Locator> {
  const cell = cellLocator(page, index);
  const slider = cell.getByRole("slider").first();
  await expect(slider).toBeVisible({ timeout: 20_000 });
  return slider;
}

async function setWidgetSliderValue(
  page: Page,
  index: number,
  value: number,
): Promise<void> {
  const slider = await widgetSlider(page, index);
  await slider.focus();
  const rawCurrent = await slider.getAttribute("aria-valuenow");
  const current = rawCurrent == null ? Number.NaN : Number(rawCurrent);
  if (!Number.isFinite(current)) {
    throw new Error("widget slider is missing aria-valuenow");
  }
  const delta = value - current;
  const key = delta >= 0 ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < Math.abs(delta); i += 1) {
    await page.keyboard.press(key);
  }
}

test("rerunning the same cell keeps prompt monotone and output intact", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-rerun-robustness");
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

  let prevExec = await readInputExecCount(page, 0);
  for (let i = 0; i < 8; i += 1) {
    const nextExec = await setCodeRunAndWait({
      page,
      index: 0,
      code: RERUN_CODE,
      outputMustContain: "999",
    });
    if (prevExec != null) {
      expect(nextExec).toBe(prevExec + 1);
    }
    prevExec = nextExec;
    const output = normalizeOutput(await readCellOutputText(page, 0));
    expect(output).toContain("0 1 2 3 4");
    expect(output).toContain("995 996 997 998 999");
  }
});

test("refresh during a long run converges to the finished output and idle state", async ({
  page,
}) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-refresh-during-run");
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

  await setCellInputCode(page, 0, REFRESH_CODE);
  await clickRunButton(page, 0);
  await expect
    .poll(async () => normalizeOutput(await readCellOutputText(page, 0)), {
      timeout: 10_000,
    })
    .toContain("0 1 2 3 4 5 6 7");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await waitForNotebookReloadReady(page);
  const refreshCell = await findCellIndexContaining(
    page,
    "from time import sleep",
  );

  const expected = Array.from({ length: 50 }, (_, i) => `${i}`).join(" ");
  await waitForOutputExact(page, refreshCell, expected, 20_000);
  await expect
    .poll(async () => await readRunButtonLabel(page, refreshCell), {
      timeout: 20_000,
    })
    .toBe("Run");

  const stable = normalizeOutput(await readCellOutputText(page, refreshCell));
  await page.waitForTimeout(1000);
  expect(normalizeOutput(await readCellOutputText(page, refreshCell))).toBe(
    stable,
  );
});

test("widgets survive reload and remain interactive", async ({ page }) => {
  const conn = await resolveBaseUrl();
  const path_ipynb = uniqueNotebookPath("jupyter-e2e-widget-refresh");
  await ensureNotebook(path_ipynb, [codeCell("pass"), codeCell(WIDGET_CODE)]);

  await openNotebookPage(
    page,
    notebookUrl({
      base_url: conn.base_url,
      path_ipynb,
      auth_token: conn.auth_token,
    }),
  );

  await ensureKernelReadyOrSkip(page, 0);
  await runCellAndWait({ page, index: 1, timeoutMs: 60_000 });
  await widgetSlider(page, 1);
  await expect
    .poll(async () => normalizeOutput(await readCellOutputText(page, 1)), {
      timeout: 20_000,
    })
    .toContain("(10, True)");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await waitForNotebookReloadReady(page);
  const widgetCell = await findCellIndexContaining(page, "@interact(x=10");
  await widgetSlider(page, widgetCell);
  await expect
    .poll(
      async () => normalizeOutput(await readCellOutputText(page, widgetCell)),
      {
        timeout: 20_000,
      },
    )
    .toContain("(10, True)");

  await setWidgetSliderValue(page, widgetCell, 11);
  await expect
    .poll(
      async () => normalizeOutput(await readCellOutputText(page, widgetCell)),
      {
        timeout: 20_000,
      },
    )
    .toContain("(11, True)");
});
