import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Page } from "@playwright/test";
import { project_id } from "@cocalc/project/data";
import { connectionInfoPath } from "../../connection-info";

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

export type NotebookUrlOptions = {
  base_url: string;
  path_ipynb: string;
  auth_token?: string;
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
}: NotebookUrlOptions): string {
  const base = new URL(base_url.endsWith("/") ? base_url : `${base_url}/`);
  const encodedPath = encodeNotebookPath(path_ipynb);
  const url = new URL(`projects/${project_id}/files/${encodedPath}`, base);
  if (auth_token) {
    url.searchParams.set("auth_token", auth_token);
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
  const ipynb = {
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
  const firstCell = page.locator('[cocalc-test="jupyter-cell"]').first();
  const deadline = Date.now() + timeout_ms;
  for (;;) {
    await firstCell.hover();
    const runButton = firstCell.getByRole("button", { name: /\bRun\b/i }).first();
    if ((await runButton.count()) > 0) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "timed out waiting for notebook to become writable (Run button not visible)",
      );
    }
    await page.waitForTimeout(200);
  }
  // Fast-open can render cells before patchflow session initialization completes.
  // Give the sync layer a short settle window before mutating notebook state.
  await page.waitForTimeout(8_000);
}

export function cellLocator(page: Page, index: number) {
  return page.locator('[cocalc-test="jupyter-cell"]').nth(index);
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
  await cell.hover();
  const runButton = cell.getByRole("button", { name: /\bRun\b/i }).first();
  if ((await runButton.count()) > 0) {
    await runButton.click();
    return;
  }
  const input = cell.locator('[cocalc-test="cell-input"] .CodeMirror').first();
  await input.click();
  await page.keyboard.press("Shift+Enter");
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
