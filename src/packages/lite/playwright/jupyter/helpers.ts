import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { project_id } from "@cocalc/project/data";
import { connectionInfoPath } from "../../connection-info";

const execFileAsync = promisify(execFile);

type ConnectionInfo = {
  pid?: number;
  port?: number;
  protocol?: string;
  host?: string;
  token?: string;
};

export type NotebookCell = {
  cell_type: "code" | "markdown" | "raw";
  execution_count?: number | null;
  metadata?: Record<string, any>;
  outputs?: any[];
  source: string[];
};

export type NotebookFile = {
  cells: NotebookCell[];
  metadata: Record<string, any>;
  nbformat: number;
  nbformat_minor: number;
};

export type NotebookUrlOptions = {
  base_url: string;
  path_ipynb: string;
  auth_token?: string;
  frame_type?: "jupyter-singledoc";
};

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function normalizeLiteHost(host: unknown): string {
  if (typeof host !== "string") return "localhost";
  const trimmed = host.trim();
  if (
    !trimmed ||
    trimmed === "0.0.0.0" ||
    trimmed === "::" ||
    trimmed === "[::]"
  ) {
    return "localhost";
  }
  return trimmed;
}

function validatedPort(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n)) return;
  if (n < 1 || n > 65535) return;
  return n;
}

function startLiteServerMessage(detail: string): Error {
  return new Error(
    `you must start a lite server running here -- 'pnpm app' (${detail})`,
  );
}

async function readConnectionInfo(): Promise<ConnectionInfo | undefined> {
  const path = connectionInfoPath();
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return undefined;
    }
    throw startLiteServerMessage(`unable to read ${path}: ${err?.message ?? err}`);
  }
}

export async function resolveBaseUrl(): Promise<{
  base_url: string;
  auth_token?: string;
}> {
  const info = await readConnectionInfo();
  if (!info) {
    throw startLiteServerMessage(`missing ${connectionInfoPath()}`);
  }
  const pid = Number(info.pid);
  const port = validatedPort(info.port);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw startLiteServerMessage(`invalid pid in ${connectionInfoPath()}`);
  }
  if (port == null) {
    throw startLiteServerMessage(`invalid port in ${connectionInfoPath()}`);
  }
  if (!isRunningPid(pid)) {
    throw startLiteServerMessage(`pid ${pid} from ${connectionInfoPath()} is not running`);
  }
  const protocol = info.protocol === "https" ? "https" : "http";
  const host = normalizeLiteHost(info.host);
  return {
    base_url: `${protocol}://${host}:${port}`,
    auth_token: info.token,
  };
}

function encodeNotebookPath(path: string): string {
  if (path.startsWith("/")) {
    return `%2F${encodeURI(path.slice(1)).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
  }
  return encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function notebookUrl({
  base_url,
  path_ipynb,
  auth_token,
  frame_type,
}: NotebookUrlOptions): string {
  const base = new URL(base_url.endsWith("/") ? base_url : `${base_url}/`);
  const encodedPath = encodeNotebookPath(path_ipynb);
  const url = new URL(`projects/${project_id}/files/${encodedPath}`, base);
  if (auth_token) {
    url.searchParams.set("auth_token", auth_token);
  }
  if (frame_type) {
    url.searchParams.set("cocalc-test-jupyter-frame", frame_type);
  }
  return url.toString();
}

export function codeCell(
  source: string,
  opts?: {
    metadata?: Record<string, any>;
    outputs?: any[];
    execution_count?: number | null;
  },
): NotebookCell {
  return {
    cell_type: "code",
    execution_count: opts?.execution_count ?? null,
    metadata: opts?.metadata ?? {},
    outputs: opts?.outputs ?? [],
    source: [source],
  };
}

export async function ensureNotebook(
  path_ipynb: string,
  cells: NotebookCell[],
): Promise<void> {
  const ipynb: NotebookFile = {
    cells,
    metadata: {
      kernelspec: {
        display_name: "Python 3 (ipykernel)",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  await mkdir(dirname(path_ipynb), { recursive: true });
  await writeFile(path_ipynb, JSON.stringify(ipynb, null, 2), "utf8");
}

export async function mutateNotebookOnDisk(
  path_ipynb: string,
  mutate: (ipynb: NotebookFile) => void,
): Promise<void> {
  const raw = await readFile(path_ipynb, "utf8");
  const ipynb = JSON.parse(raw) as NotebookFile;
  mutate(ipynb);
  await writeFile(path_ipynb, JSON.stringify(ipynb, null, 2), "utf8");
  const t = new Date(Date.now() + 2000);
  await utimes(path_ipynb, t, t).catch(() => undefined);
}

export function uniqueNotebookPath(prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const baseDir =
    process.env.COCALC_JUPYTER_E2E_DIR?.trim() || `${process.cwd()}/.playwright-jupyter`;
  return `${baseDir}/${safePrefix}-${randomUUID()}.ipynb`;
}

export async function openNotebookPage(
  page: Page,
  url: string,
  timeout_ms: number = 45_000,
): Promise<void> {
  await page.goto(trimTrailingSlash(url), {
    waitUntil: "domcontentloaded",
    timeout: timeout_ms,
  });
  await page.waitForSelector('[cocalc-test="jupyter-cell"]', {
    timeout: timeout_ms,
  });
  await page.waitForSelector('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: timeout_ms,
  });
  // Fast-open can render cells before patchflow session initialization completes.
  // Give the sync layer a short settle window before mutating notebook state.
  await page.waitForTimeout(8_000);
}

export async function openSingleDocNotebookPage(
  page: Page,
  url: string,
  timeout_ms: number = 45_000,
): Promise<void> {
  await page.goto(trimTrailingSlash(url), {
    waitUntil: "domcontentloaded",
    timeout: timeout_ms,
  });
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const switched = await page.evaluate(() => {
      if (
        document.querySelector('[data-cocalc-jupyter-slate-single-doc="1"]') !=
        null
      ) {
        return { ok: true, mode: "already-singledoc" };
      }
      const redux = (window as any).cocalc?.redux ?? (window as any).redux;
      const actions = redux?._actions ?? {};
      const stores = redux?._stores ?? {};
      const encodedPath = window.location.pathname.split("/files/")[1] ?? "";
      const currentPath = encodedPath ? `/${decodeURIComponent(encodedPath)}` : undefined;
      const candidates = Object.keys(actions).filter(
        (name) =>
          typeof actions[name]?.set_frame_tree === "function" &&
          actions[name]?.jupyter_actions != null,
      );
      if (candidates.length === 0) {
        return { ok: false, reason: "missing-actions" };
      }
      const bestMatch =
        candidates.find(
          (name) => currentPath != null && stores[name]?.get?.("path") === currentPath,
        ) ?? candidates[0];
      const localViewState = stores[bestMatch]?.get?.("local_view_state");
      const activeId = localViewState?.get?.("active_id");
      if (
        activeId != null &&
        typeof actions[bestMatch]?.set_frame_type === "function"
      ) {
        actions[bestMatch].set_frame_type(
          activeId,
          "jupyter_slate_single_doc_notebook",
        );
      } else {
        actions[bestMatch].set_frame_tree({
          type: "jupyter_slate_single_doc_notebook",
        });
      }
      return { ok: true, mode: "switched", action: bestMatch };
    });
    if (switched?.ok) {
      try {
        await page.waitForSelector('[data-cocalc-jupyter-slate-single-doc="1"]', {
          timeout: 2_000,
        });
        break;
      } catch {
        // keep polling until selector appears
      }
    }
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('[data-cocalc-jupyter-slate-single-doc="1"]', {
    timeout: timeout_ms,
  });
  await page.waitForSelector('[data-cocalc-test="jupyter-singledoc-code-cell"]', {
    timeout: timeout_ms,
  });
  await page.waitForTimeout(8_000);
}

export function cellLocator(page: Page, index: number) {
  return page.locator('[cocalc-test="jupyter-cell"]').nth(index);
}

export async function countCells(page: Page): Promise<number> {
  return await page.locator('[cocalc-test="jupyter-cell"]').count();
}

export async function setCellInputCode(
  page: Page,
  index: number,
  code: string,
): Promise<void> {
  const input = cellLocator(page, index).locator('[cocalc-test="cell-input"] .CodeMirror').first();
  await input.click();
  await input.evaluate(
    (element: any, value: string) => {
      const cm = element?.CodeMirror;
      if (!cm) {
        throw new Error("CodeMirror editor not available");
      }
      cm.setValue(value);
      cm.focus();
      const line = Math.max(0, cm.lineCount() - 1);
      const ch = cm.getLine(line)?.length ?? 0;
      cm.setCursor({ line, ch });
    },
    code,
  );
}

export async function clickRunButton(page: Page, index: number): Promise<void> {
  const cell = cellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  const input = cell.locator('[cocalc-test="cell-input"] .CodeMirror').first();
  await input.click();
  await page.keyboard.press("Shift+Enter");
}

export function singleDocCodeCellLocator(page: Page, index: number) {
  return page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').nth(index);
}

export async function countSingleDocCodeCells(page: Page): Promise<number> {
  return await page.locator('[data-cocalc-test="jupyter-singledoc-code-cell"]').count();
}

export async function pressSingleDocRunShortcut(
  page: Page,
  index: number,
  shortcut: "Shift+Enter" | "Alt+Enter",
): Promise<void> {
  const cell = singleDocCodeCellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  await cell.locator(".cocalc-slate-code-block").first().click();
  await page.keyboard.press(shortcut);
}

export async function readSingleDocOutputText(
  page: Page,
  index: number,
): Promise<string> {
  const output = page
    .locator('[data-cocalc-test="jupyter-singledoc-output"]')
    .nth(index);
  if ((await output.count()) === 0) {
    return "";
  }
  return await output.innerText();
}

export async function killKernelProcessesForE2E(): Promise<void> {
  // Best-effort crash simulation for notebook kernels. Tests run serially,
  // so killing all local kernel worker processes is acceptable here.
  try {
    await execFileAsync("bash", [
      "-lc",
      "pkill -f 'ipykernel_launcher|sage\\.repl\\.ipython_kernel|kernel-.*\\.json' >/dev/null 2>&1 || true",
    ]);
  } catch {
    // ignore failures; callers verify behavior via UI state transitions
  }
}

export async function readRunButtonLabel(
  page: Page,
  index: number,
): Promise<"Run" | "Stop" | "Unknown"> {
  const cell = cellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const runStopButton = cell.getByRole("button", { name: /Run|Stop/ }).first();
  if ((await runStopButton.count()) === 0) {
    return "Unknown";
  }
  const text = (await runStopButton.innerText()).trim();
  if (/\bStop\b/i.test(text)) {
    return "Stop";
  }
  if (/\bRun\b/i.test(text)) {
    return "Run";
  }
  return "Unknown";
}

export async function readCellText(page: Page, index: number): Promise<string> {
  return await cellLocator(page, index).innerText();
}

export async function readCellOutputText(
  page: Page,
  index: number,
): Promise<string> {
  const output = cellLocator(page, index).locator('[cocalc-test="cell-output"]');
  if ((await output.count()) === 0) {
    return "";
  }
  return await output.first().innerText();
}

export async function readInputExecCount(
  page: Page,
  index: number,
): Promise<number | undefined> {
  const text = await readCellText(page, index);
  const m = text.match(/\bIn\s*\[(\d+)\]\s*:/);
  if (!m) return;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return;
  return n;
}

export async function readInputPromptState(
  page: Page,
  index: number,
): Promise<string | undefined> {
  const cell = cellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const prompt = cell
    .locator('[cocalc-test="cell-input-prompt"]')
    .first();
  if ((await prompt.count()) === 0) {
    return;
  }
  const state = await prompt.getAttribute("data-cocalc-input-state");
  return state == null || state === "" ? undefined : state;
}

export async function readCellTimingState(
  page: Page,
  index: number,
): Promise<string | undefined> {
  const cell = cellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const timing = cell.locator('[cocalc-test="cell-timing"]').first();
  if ((await timing.count()) === 0) {
    return;
  }
  const state = await timing.getAttribute("data-cocalc-cell-timing-state");
  return state == null || state === "" ? undefined : state;
}

export async function readCellTimingLastMs(
  page: Page,
  index: number,
): Promise<number | undefined> {
  const cell = cellLocator(page, index);
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const timing = cell.locator('[cocalc-test="cell-timing"]').first();
  if ((await timing.count()) === 0) {
    return;
  }
  const value = await timing.getAttribute("data-cocalc-cell-last-ms");
  if (value == null || value === "") {
    return;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return;
  }
  return n;
}

export async function readKernelWarningVisible(page: Page): Promise<boolean> {
  const value = await page.evaluate(
    () =>
      document.documentElement.getAttribute(
        "data-cocalc-jupyter-kernel-warning-visible",
      ) ?? "",
  );
  return value === "1";
}

export async function readKernelWarningText(page: Page): Promise<string> {
  return await page.evaluate(
    () =>
      document.documentElement.getAttribute(
        "data-cocalc-jupyter-kernel-warning-text",
      ) ?? "",
  );
}

async function setKernelErrorInternal(
  page: Page,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastReason = "unknown";
  while (Date.now() < deadline) {
    const result = await page.evaluate((msg: string) => {
      const hasEventSurface =
        document.documentElement.getAttribute(
          "data-cocalc-jupyter-test-set-kernel-error",
        ) === "1";
      if (hasEventSurface) {
        window.dispatchEvent(
          new CustomEvent("cocalc:jupyter:set-kernel-error-for-test", {
            detail: { message: msg },
          }),
        );
        return { ok: true, source: "event" as const };
      }

      const runtime = (window as any).__cocalcJupyterRuntime;
      if (typeof runtime?.set_kernel_error_for_test === "function") {
        runtime.set_kernel_error_for_test(msg);
        return { ok: true, source: "runtime" as const };
      }

      const redux = (window as any).cocalc?.redux ?? (window as any).redux;
      if (!redux) {
        return { ok: false, reason: "missing-redux" };
      }
      const actions = redux?._actions ?? {};
      const stores = redux?._stores ?? {};
      const encodedPath = window.location.pathname.split("/files/")[1] ?? "";
      const currentPath = encodedPath
        ? `/${decodeURIComponent(encodedPath)}`
        : undefined;
      const candidates = Object.keys(actions).filter(
        (name) => typeof actions[name]?.set_kernel_error === "function",
      );
      if (candidates.length === 0) {
        return { ok: false, reason: "missing-actions" };
      }
      const bestMatch =
        candidates.find(
          (name) =>
            currentPath != null && stores[name]?.get?.("path") === currentPath,
        ) ?? candidates[0];
      actions[bestMatch].set_kernel_error(msg);
      return { ok: true, source: "redux" as const };
    }, message);
    if (result?.ok) {
      return;
    }
    lastReason = result?.reason ?? "unknown";
    await page.waitForTimeout(250);
  }
  throw new Error(
    `missing kernel error hooks (__cocalcJupyterRuntime/cocalc.redux actions): ${lastReason}`,
  );
}

export async function canSetKernelErrorForE2E(
  page: Page,
  timeoutMs: number = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const canSet = await page.evaluate(() => {
      if (
        document.documentElement.getAttribute(
          "data-cocalc-jupyter-test-set-kernel-error",
        ) === "1"
      ) {
        return true;
      }
      const runtime = (window as any).__cocalcJupyterRuntime;
      if (typeof runtime?.set_kernel_error_for_test === "function") {
        return true;
      }
      const redux = (window as any).cocalc?.redux ?? (window as any).redux;
      const actions = redux?._actions ?? {};
      return Object.keys(actions).some(
        (name) => typeof actions[name]?.set_kernel_error === "function",
      );
    });
    if (canSet) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

export async function setKernelErrorForE2E(
  page: Page,
  message: string,
): Promise<void> {
  await setKernelErrorInternal(page, message);
}

export async function clearKernelErrorForE2E(page: Page): Promise<void> {
  await setKernelErrorInternal(page, "");
}
