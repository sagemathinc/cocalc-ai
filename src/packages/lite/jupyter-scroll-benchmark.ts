/*
Playwright scroll benchmark for Jupyter notebook virtualization reliability.

This targets a real running CoCalc Lite server and evaluates scrolling
performance and stability on synthetic large notebooks.

Examples:

  pnpm -C src/packages/lite jupyter:bench:scroll -- --help
  pnpm -C src/packages/lite jupyter:bench:scroll -- --profile quick
  pnpm -C src/packages/lite jupyter:bench:scroll -- --profile full --headed
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AsciiTable3 } from "ascii-table3";
import { encode_path } from "@cocalc/util/misc";
import { project_id } from "@cocalc/project/data";
import { connectionInfoPath } from "./connection-info";

type Options = {
  base_url?: string;
  port?: number;
  host?: string;
  protocol?: "http" | "https";
  auth_token?: string;
  profile: "quick" | "full";
  virtualization: "on" | "off" | "keep";
  scenario?: string;
  path_prefix: string;
  cycles?: number;
  scroll_steps: number;
  typing_chars: number;
  typing_timeout_ms: number;
  timeout_ms: number;
  headless: boolean;
  json: boolean;
  quiet: boolean;
};

type ConnectionInfo = {
  pid?: number;
  port?: number;
  protocol?: string;
  host?: string;
  token?: string;
};

type ScenarioSpec = {
  name: string;
  description: string;
  path_ipynb: string;
  expected_cells: number;
  top_marker: string;
  bottom_marker: string;
  cells: any[];
};

type FrameDeltaStats = {
  min: number;
  mean: number;
  p95: number;
  max: number;
  count: number;
};

type ScrollMetrics = {
  duration_ms: number;
  max_scroll_px: number;
  dom_cells_top: number;
  dom_cells_mid: number;
  dom_cells_bottom: number;
  frame_delta_ms: FrameDeltaStats | null;
  approx_fps: number | null;
  longtask_count: number;
  longtask_max_ms: number | null;
  top_marker_visible_initial: boolean;
  bottom_marker_visible_initial: boolean;
  top_marker_visible_after: boolean;
  bottom_marker_visible_after: boolean;
  windowed_list_attr: boolean | null;
  windowed_list_source: "attr" | "virtuoso" | "unknown";
};

type OpenMetrics = {
  goto_ms: number;
  first_cell_ms: number;
  first_input_ms: number;
  ready_ms: number;
};

type TypingMetrics = {
  chars: number;
  samples: number;
  timeout_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  mean_ms: number | null;
  max_ms: number | null;
};

type ScenarioResult = {
  name: string;
  description: string;
  profile: "quick" | "full";
  path_ipynb: string;
  expected_cells: number;
  cycles: number;
  scroll_steps: number;
  metrics: ScrollMetrics;
  virtualization_likely: boolean;
  reliability_ok: boolean;
  virtualization_mode: Options["virtualization"];
  virtualization_active: boolean | null;
  open_metrics: OpenMetrics;
  typing_metrics: TypingMetrics;
};

type ScrollBenchmarkResult = {
  ok: boolean;
  base_url: string;
  profile: "quick" | "full";
  virtualization: Options["virtualization"];
  scenario_filter?: string;
  cycles: number;
  scroll_steps: number;
  typing_chars: number;
  typing_timeout_ms: number;
  timeout_ms: number;
  runs: ScenarioResult[];
  started_at: string;
  finished_at: string;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PROFILE: Options["profile"] = "quick";
const DEFAULT_SCROLL_STEPS = 42;
const DEFAULT_TYPING_CHARS = 40;
const DEFAULT_TYPING_TIMEOUT_MS = 1_500;

function requireHomeDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME must be set in lite mode");
  }
  return home;
}

const DEFAULT_PATH_PREFIX = `${requireHomeDir()}/jupyter-scroll-benchmark`;

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

function validatedPort(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n)) return;
  if (n < 1 || n > 65535) return;
  return n;
}

async function resolveBaseUrl(opts: Options): Promise<{
  base_url: string;
  connection_info?: ConnectionInfo;
}> {
  if (opts.base_url) {
    return { base_url: trimTrailingSlash(opts.base_url) };
  }
  const info = await readConnectionInfo();
  if (opts.port != null) {
    const protocol =
      opts.protocol ?? (info?.protocol === "https" ? "https" : "http");
    const host = opts.host ?? normalizeLiteHost(info?.host);
    return { base_url: `${protocol}://${host}:${opts.port}`, connection_info: info };
  }
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
    throw startLiteServerMessage(
      `pid ${pid} from ${connectionInfoPath()} is not running`,
    );
  }
  const protocol = info.protocol === "https" ? "https" : "http";
  const host = normalizeLiteHost(info.host);
  return {
    base_url: `${protocol}://${host}:${port}`,
    connection_info: info,
  };
}

function encodeNotebookPath(path: string): string {
  if (path.startsWith("/")) {
    return `%2F${encode_path(path.slice(1))}`;
  }
  return encode_path(path);
}

function notebookUrl({
  base_url,
  path_ipynb,
  auth_token,
  virtualization,
}: {
  base_url: string;
  path_ipynb: string;
  auth_token?: string;
  virtualization: Options["virtualization"];
}): string {
  const base = new URL(base_url.endsWith("/") ? base_url : `${base_url}/`);
  const encodedPath = encodeNotebookPath(path_ipynb);
  const url = new URL(`projects/${project_id}/files/${encodedPath}`, base);
  if (auth_token) {
    url.searchParams.set("auth_token", auth_token);
  }
  if (virtualization !== "keep") {
    url.searchParams.set("jupyter_virtualization", virtualization);
  }
  return url.toString();
}

function markdownCell(source: string): any {
  return {
    cell_type: "markdown",
    metadata: {},
    source: [source],
  };
}

function codeCell({
  source,
  outputs,
  execution_count,
}: {
  source: string;
  outputs: any[];
  execution_count: number;
}): any {
  return {
    cell_type: "code",
    execution_count,
    metadata: {},
    outputs,
    source: [source],
  };
}

function streamOutput(text: string): any {
  return {
    output_type: "stream",
    name: "stdout",
    text: [text],
  };
}

function htmlOutput(html: string, plain: string): any {
  return {
    output_type: "display_data",
    data: {
      "text/plain": [plain],
      "text/html": [html],
    },
    metadata: {},
  };
}

function buildTextScenarioCells({
  count,
  topMarker,
  bottomMarker,
}: {
  count: number;
  topMarker: string;
  bottomMarker: string;
}): any[] {
  const cells: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const marker =
      i === 0 ? topMarker : i === count - 1 ? bottomMarker : `CELL-${i}`;
    const source = `# ${marker}\nprint(${i})`;
    const payload = `${marker} ${"x".repeat(200)}\n`;
    cells.push(
      codeCell({
        source,
        outputs: [streamOutput(payload)],
        execution_count: i + 1,
      }),
    );
  }
  return cells;
}

function buildMixedScenarioCells({
  count,
  topMarker,
  bottomMarker,
}: {
  count: number;
  topMarker: string;
  bottomMarker: string;
}): any[] {
  const cells: any[] = [];
  let execCount = 1;
  for (let i = 0; i < count; i += 1) {
    if (i === 0 || i === count - 1 || i % 6 !== 0) {
      const marker =
        i === 0 ? topMarker : i === count - 1 ? bottomMarker : `MIXED-${i}`;
      if (i % 4 === 0 && i > 0 && i < count - 1) {
        cells.push(
          codeCell({
            source: `# ${marker}\n${i} + 1`,
            outputs: [
              htmlOutput(
                `<div class=\"virt-html\"><b>${marker}</b><div style=\"height:40px\">row ${i}</div></div>`,
                marker,
              ),
            ],
            execution_count: execCount,
          }),
        );
      } else {
        cells.push(
          codeCell({
            source: `# ${marker}\n${i} + 1`,
            outputs: [streamOutput(`${marker} ${"y".repeat(120)}\n`)],
            execution_count: execCount,
          }),
        );
      }
      execCount += 1;
    } else {
      cells.push(
        markdownCell(
          `### Section ${i}\nThis markdown cell is part of virtualization scroll testing.`,
        ),
      );
    }
  }
  return cells;
}

function notebookTemplate(cells: any[]): string {
  return JSON.stringify(
    {
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
    },
    null,
    2,
  );
}

function buildScenarios(opts: Options): ScenarioSpec[] {
  const mkPath = (name: string) => `${opts.path_prefix}-${name}.ipynb`;

  const quick: ScenarioSpec[] = [
    {
      name: "text_400",
      description: "400 code cells with medium stream outputs",
      path_ipynb: mkPath("text-400"),
      expected_cells: 400,
      top_marker: "SCROLL-TOP-TEXT-400",
      bottom_marker: "SCROLL-BOTTOM-TEXT-400",
      cells: buildTextScenarioCells({
        count: 400,
        topMarker: "SCROLL-TOP-TEXT-400",
        bottomMarker: "SCROLL-BOTTOM-TEXT-400",
      }),
    },
    {
      name: "mixed_280",
      description: "280 mixed markdown/stream/html cells",
      path_ipynb: mkPath("mixed-280"),
      expected_cells: 280,
      top_marker: "SCROLL-TOP-MIXED-280",
      bottom_marker: "SCROLL-BOTTOM-MIXED-280",
      cells: buildMixedScenarioCells({
        count: 280,
        topMarker: "SCROLL-TOP-MIXED-280",
        bottomMarker: "SCROLL-BOTTOM-MIXED-280",
      }),
    },
  ];

  const full: ScenarioSpec[] = [
    {
      name: "text_1200",
      description: "1200 code cells with medium stream outputs",
      path_ipynb: mkPath("text-1200"),
      expected_cells: 1200,
      top_marker: "SCROLL-TOP-TEXT-1200",
      bottom_marker: "SCROLL-BOTTOM-TEXT-1200",
      cells: buildTextScenarioCells({
        count: 1200,
        topMarker: "SCROLL-TOP-TEXT-1200",
        bottomMarker: "SCROLL-BOTTOM-TEXT-1200",
      }),
    },
    {
      name: "mixed_700",
      description: "700 mixed markdown/stream/html cells",
      path_ipynb: mkPath("mixed-700"),
      expected_cells: 700,
      top_marker: "SCROLL-TOP-MIXED-700",
      bottom_marker: "SCROLL-BOTTOM-MIXED-700",
      cells: buildMixedScenarioCells({
        count: 700,
        topMarker: "SCROLL-TOP-MIXED-700",
        bottomMarker: "SCROLL-BOTTOM-MIXED-700",
      }),
    },
  ];

  const base = opts.profile === "full" ? full : quick;
  if (!opts.scenario) {
    return base;
  }
  return base.filter((x) => x.name === opts.scenario);
}

async function ensureNotebook(path_ipynb: string, cells: any[]): Promise<void> {
  await mkdir(dirname(path_ipynb), { recursive: true });
  await writeFile(path_ipynb, notebookTemplate(cells), "utf8");
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

async function openNotebookPage({
  page,
  url,
  timeout_ms,
}: {
  page: any;
  url: string;
  timeout_ms: number;
}): Promise<OpenMetrics> {
  const t0 = monotonicNowMs();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout_ms });
  const goto_ms = monotonicNowMs() - t0;
  await page.waitForSelector('[cocalc-test="jupyter-cell"]', {
    timeout: timeout_ms,
  });
  const first_cell_ms = monotonicNowMs() - t0;
  await page.waitForSelector('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: timeout_ms,
  });
  const first_input_ms = monotonicNowMs() - t0;
  await page.waitForTimeout(300);
  const ready_ms = monotonicNowMs() - t0;
  return { goto_ms, first_cell_ms, first_input_ms, ready_ms };
}

async function measureScrollScenario({
  page,
  cycles,
  scroll_steps,
  top_marker,
  bottom_marker,
  timeout_ms,
}: {
  page: any;
  cycles: number;
  scroll_steps: number;
  top_marker: string;
  bottom_marker: string;
  timeout_ms: number;
}): Promise<ScrollMetrics> {
  const result = await page.evaluate(
    async ({ cycles, scroll_steps, top_marker, bottom_marker, timeout_ms }) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const raf = () =>
        new Promise<number>((resolve) => {
          requestAnimationFrame((t) => resolve(t));
        });

      function findScrollContainer(): HTMLElement | null {
        const start = document.querySelector(
          '[cocalc-test="jupyter-cell"]',
        ) as HTMLElement | null;
        if (start == null) return null;
        let node: HTMLElement | null = start;
        while (node != null) {
          const style = getComputedStyle(node);
          const oy = style.overflowY;
          if (
            (oy === "auto" || oy === "scroll" || oy === "overlay") &&
            node.scrollHeight > node.clientHeight + 8
          ) {
            return node;
          }
          node = node.parentElement;
        }
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(".smc-vfill"),
        );
        for (const c of candidates) {
          const style = getComputedStyle(c);
          if (
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            c.scrollHeight > c.clientHeight + 8
          ) {
            return c;
          }
        }
        return (document.scrollingElement as HTMLElement | null) ?? null;
      }

      function countVisibleCellDomNodes(scroller: HTMLElement): number {
        const nodes = Array.from(
          scroller.querySelectorAll<HTMLElement>('[cocalc-test="jupyter-cell"]'),
        );
        const ids = new Set<string>();
        for (const node of nodes) {
          const id = node.id?.trim();
          if (id) {
            ids.add(id);
          }
        }
        if (ids.size > 0) {
          return ids.size;
        }
        return nodes.length;
      }

      function markerVisible(marker: string): boolean {
        if (!marker) return false;
        return document.body.innerText.includes(marker);
      }

      function percentile(v: number[], p: number): number {
        if (v.length === 0) return 0;
        const sorted = [...v].sort((a, b) => a - b);
        const i = Math.min(
          sorted.length - 1,
          Math.max(0, Math.floor(p * (sorted.length - 1))),
        );
        return sorted[i];
      }

      const startTs = performance.now();
      const scroller = findScrollContainer();
      if (scroller == null) {
        throw new Error("failed to detect notebook scroll container");
      }

      const longtasks: number[] = [];
      let observer: PerformanceObserver | null = null;
      if (typeof PerformanceObserver !== "undefined") {
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longtasks.push(entry.duration);
            }
          });
          observer.observe({ type: "longtask", buffered: true } as any);
        } catch {
          observer = null;
        }
      }

      const frameDeltas: number[] = [];
      let prevFrame: number | null = null;
      const tick = async () => {
        const t = await raf();
        if (prevFrame != null) {
          frameDeltas.push(t - prevFrame);
        }
        prevFrame = t;
      };

      const scrollTo = async (target: number, steps: number) => {
        const start = scroller.scrollTop;
        for (let i = 1; i <= steps; i += 1) {
          const x = start + ((target - start) * i) / steps;
          scroller.scrollTop = x;
          await tick();
        }
      };

      await tick();
      scroller.scrollTop = 0;
      await sleep(140);
      await tick();

      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const modeNode = document.querySelector(
        '[cocalc-test="jupyter-cell-list-mode"]',
      ) as HTMLElement | null;
      const windowedAttrRaw =
        modeNode?.getAttribute("data-jupyter-windowed-list") ??
        scroller.getAttribute("data-jupyter-windowed-list");
      const windowedListAttrFromMarker =
        windowedAttrRaw === "1"
          ? true
          : windowedAttrRaw === "0"
            ? false
            : null;
      const hasVirtuoso =
        document.querySelector("[data-virtuoso-scroller]") != null ||
        document.querySelector("[data-virtuoso-item-list]") != null;
      const windowedListAttr =
        windowedListAttrFromMarker ?? (hasVirtuoso ? true : false);
      const windowedListSource: "attr" | "virtuoso" | "unknown" =
        windowedListAttrFromMarker != null
          ? "attr"
          : hasVirtuoso
            ? "virtuoso"
            : "unknown";
      const domTop = countVisibleCellDomNodes(scroller);
      const topVisibleInitially = markerVisible(top_marker);

      await scrollTo(maxScroll * 0.5, Math.max(10, Math.floor(scroll_steps / 2)));
      await sleep(90);
      await tick();
      const domMid = countVisibleCellDomNodes(scroller);

      await scrollTo(maxScroll, scroll_steps);
      await sleep(140);
      await tick();
      const domBottom = countVisibleCellDomNodes(scroller);
      const bottomVisibleInitially = markerVisible(bottom_marker);

      for (let i = 0; i < cycles; i += 1) {
        await scrollTo(0, scroll_steps);
        await sleep(60);
        await scrollTo(maxScroll, scroll_steps);
        await sleep(60);
        if (performance.now() - startTs > timeout_ms) {
          throw new Error(`scroll cycle timed out after ${timeout_ms}ms`);
        }
      }

      await scrollTo(0, scroll_steps);
      await sleep(140);
      await tick();
      const topVisibleAfter = markerVisible(top_marker);

      await scrollTo(maxScroll, scroll_steps);
      await sleep(140);
      await tick();
      const bottomVisibleAfter = markerVisible(bottom_marker);

      observer?.disconnect();

      const elapsed = performance.now() - startTs;
      const frameCount = frameDeltas.length;
      const sum = frameDeltas.reduce((acc, x) => acc + x, 0);
      const frameMean = frameCount > 0 ? sum / frameCount : 0;
      const frameMin = frameCount > 0 ? Math.min(...frameDeltas) : 0;
      const frameMax = frameCount > 0 ? Math.max(...frameDeltas) : 0;
      const frameP95 = frameCount > 0 ? percentile(frameDeltas, 0.95) : 0;

      return {
        duration_ms: elapsed,
        max_scroll_px: maxScroll,
        dom_cells_top: domTop,
        dom_cells_mid: domMid,
        dom_cells_bottom: domBottom,
        frame_delta_ms:
          frameCount === 0
            ? null
            : {
                min: frameMin,
                mean: frameMean,
                p95: frameP95,
                max: frameMax,
                count: frameCount,
              },
        approx_fps: frameMean > 0 ? 1000 / frameMean : null,
        longtask_count: longtasks.length,
        longtask_max_ms: longtasks.length > 0 ? Math.max(...longtasks) : null,
        top_marker_visible_initial: topVisibleInitially,
        bottom_marker_visible_initial: bottomVisibleInitially,
        top_marker_visible_after: topVisibleAfter,
        bottom_marker_visible_after: bottomVisibleAfter,
        windowed_list_attr: windowedListAttr,
        windowed_list_source: windowedListSource,
      };
    },
    { cycles, scroll_steps, top_marker, bottom_marker, timeout_ms },
  );

  return result as ScrollMetrics;
}

function percentileValue(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.max(0, Math.ceil(sorted.length * clamped) - 1);
  return sorted[Math.min(sorted.length - 1, index)];
}

function meanValue(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, x) => acc + x, 0);
  return sum / values.length;
}

async function prepareTypingProbe(page: any): Promise<void> {
  await page.evaluate(() => {
    const g = window as any;
    if (g.__cocalcTypingProbe != null) return;

    const root = document.querySelector(
      '[cocalc-test="cell-input"] .CodeMirror',
    ) as HTMLElement | null;
    if (root == null) {
      throw new Error("unable to find CodeMirror for typing probe");
    }
    const target = (root.querySelector(".CodeMirror-code") as HTMLElement | null) ?? root;
    const state: {
      waiting: boolean;
      keyTs: number;
      resolve: ((value: number) => void) | null;
      reject: ((reason: Error) => void) | null;
      timeout: number | null;
    } = {
      waiting: false,
      keyTs: 0,
      resolve: null,
      reject: null,
      timeout: null,
    };

    const cleanup = () => {
      if (state.timeout != null) {
        clearTimeout(state.timeout);
      }
      state.waiting = false;
      state.keyTs = 0;
      state.resolve = null;
      state.reject = null;
      state.timeout = null;
    };

    root.addEventListener(
      "keydown",
      () => {
        if (!state.waiting || state.keyTs !== 0) return;
        state.keyTs = performance.now();
      },
      true,
    );

    const onDocumentChange = () => {
      if (!state.waiting || state.keyTs === 0 || state.resolve == null) return;
      const ms = performance.now() - state.keyTs;
      const resolve = state.resolve;
      cleanup();
      resolve(ms);
    };

    const getCM = () => (root as any).CodeMirror;
    const cmForEvents = getCM();
    if (cmForEvents?.on) {
      cmForEvents.on("changes", onDocumentChange);
    } else {
      const observer = new MutationObserver(onDocumentChange);
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    g.__cocalcTypingProbe = {
      focus() {
        const cm = getCM();
        cm?.focus?.();
        const textarea = root.querySelector("textarea") as HTMLTextAreaElement | null;
        textarea?.focus();
      },
      reset() {
        const cm = getCM();
        cm?.setValue?.("");
        cm?.focus?.();
      },
      begin(timeoutMs: number): Promise<number> {
        if (state.waiting) {
          throw new Error("typing probe already waiting");
        }
        state.waiting = true;
        state.keyTs = 0;
        return new Promise<number>((resolve, reject) => {
          state.resolve = resolve;
          state.reject = reject;
          state.timeout = window.setTimeout(() => {
            const rejectFn = state.reject;
            cleanup();
            rejectFn?.(new Error("typing mutation timeout"));
          }, timeoutMs);
        });
      },
    };
  });
}

async function measureTypingScenario({
  page,
  chars,
  typing_timeout_ms,
  action_timeout_ms,
}: {
  page: any;
  chars: number;
  typing_timeout_ms: number;
  action_timeout_ms: number;
}): Promise<TypingMetrics> {
  if (chars <= 0) {
    return {
      chars: 0,
      samples: 0,
      timeout_count: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      mean_ms: null,
      max_ms: null,
    };
  }

  await prepareTypingProbe(page);
  await page.click('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: action_timeout_ms,
  });
  await page.evaluate(() => {
    const probe = (window as any).__cocalcTypingProbe;
    probe.reset();
    probe.focus();
  });

  const samples: number[] = [];
  let timeout_count = 0;

  for (let i = 0; i < chars; i += 1) {
    await page.evaluate(() => (window as any).__cocalcTypingProbe.focus());
    const wait = page.evaluate((typingTimeoutMs) => {
      return (window as any).__cocalcTypingProbe.begin(typingTimeoutMs);
    }, typing_timeout_ms);
    await page.keyboard.type("x");
    try {
      const latency = (await wait) as number;
      if (Number.isFinite(latency)) {
        samples.push(latency);
      }
    } catch {
      timeout_count += 1;
      await page.evaluate(() => (window as any).__cocalcTypingProbe.focus());
    }
  }

  return {
    chars,
    samples: samples.length,
    timeout_count,
    p50_ms: percentileValue(samples, 0.5),
    p95_ms: percentileValue(samples, 0.95),
    p99_ms: percentileValue(samples, 0.99),
    mean_ms: meanValue(samples),
    max_ms: samples.length > 0 ? Math.max(...samples) : null,
  };
}

function fmtMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function fmtMaybeMs(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)} ms`;
}

function fmtMaybeNum(value: number | null): string {
  return value == null ? "n/a" : value.toFixed(1);
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

function printSummaryTable(result: ScrollBenchmarkResult) {
  const table = new AsciiTable3("Jupyter Scroll Benchmark");
  table.setHeading(
    "Scenario",
    "VirtMode",
    "Active",
    "ActSrc",
    "Cells",
    "Dur",
    "FPS",
    "Frame p95",
    "LongTasks",
    "DOM T/M/B",
    "Virt?",
    "Reliable?",
  );
  for (const run of result.runs) {
    table.addRow(
      run.name,
      run.virtualization_mode,
      run.virtualization_active == null ? "n/a" : yesNo(run.virtualization_active),
      run.metrics.windowed_list_source,
      String(run.expected_cells),
      fmtMs(run.metrics.duration_ms),
      fmtMaybeNum(run.metrics.approx_fps),
      run.metrics.frame_delta_ms
        ? fmtMaybeMs(run.metrics.frame_delta_ms.p95)
        : "n/a",
      String(run.metrics.longtask_count),
      `${run.metrics.dom_cells_top}/${run.metrics.dom_cells_mid}/${run.metrics.dom_cells_bottom}`,
      yesNo(run.virtualization_likely),
      yesNo(run.reliability_ok),
    );
  }
  table.setAlignLeft(0);
  table.setAlignLeft(1);
  table.setAlignLeft(2);
  table.setAlignLeft(3);
  table.setAlignRight(4);
  table.setAlignRight(5);
  table.setAlignRight(6);
  table.setAlignRight(7);
  table.setAlignRight(8);
  table.setAlignRight(9);
  table.setAlignRight(10);
  table.setAlignRight(11);
  console.log(table.toString());
}

function printReliabilityMatrix(result: ScrollBenchmarkResult) {
  const table = new AsciiTable3("Virtualization Reliability Matrix");
  table.setHeading(
    "Scenario",
    "VirtMode",
    "Active",
    "ActSrc",
    "Description",
    "Top Marker",
    "Bottom Marker",
    "Max Scroll",
    "Status",
  );
  for (const run of result.runs) {
    const top = run.metrics.top_marker_visible_after;
    const bottom = run.metrics.bottom_marker_visible_after;
    const scrolled = run.metrics.max_scroll_px > 0;
    const status = top && bottom && scrolled ? "PASS" : "FAIL";
    table.addRow(
      run.name,
      run.virtualization_mode,
      run.virtualization_active == null ? "n/a" : yesNo(run.virtualization_active),
      run.metrics.windowed_list_source,
      run.description,
      yesNo(top),
      yesNo(bottom),
      `${Math.round(run.metrics.max_scroll_px)} px`,
      status,
    );
  }
  table.setAlignLeft(0);
  table.setAlignLeft(1);
  table.setAlignLeft(2);
  table.setAlignLeft(3);
  table.setAlignLeft(4);
  table.setAlignRight(5);
  table.setAlignRight(6);
  table.setAlignRight(7);
  table.setAlignRight(8);
  console.log(table.toString());
}

function printInteractionTable(result: ScrollBenchmarkResult) {
  const table = new AsciiTable3("Notebook Interaction Metrics");
  table.setHeading(
    "Scenario",
    "VirtMode",
    "Active",
    "Open Cell",
    "Open Input",
    "Open Ready",
    "Type p50",
    "Type p95",
    "Type p99",
    "Type max",
    "Timeouts",
  );
  for (const run of result.runs) {
    table.addRow(
      run.name,
      run.virtualization_mode,
      run.virtualization_active == null ? "n/a" : yesNo(run.virtualization_active),
      fmtMs(run.open_metrics.first_cell_ms),
      fmtMs(run.open_metrics.first_input_ms),
      fmtMs(run.open_metrics.ready_ms),
      fmtMaybeMs(run.typing_metrics.p50_ms),
      fmtMaybeMs(run.typing_metrics.p95_ms),
      fmtMaybeMs(run.typing_metrics.p99_ms),
      fmtMaybeMs(run.typing_metrics.max_ms),
      String(run.typing_metrics.timeout_count),
    );
  }
  table.setAlignLeft(0);
  table.setAlignLeft(1);
  table.setAlignLeft(2);
  table.setAlignRight(3);
  table.setAlignRight(4);
  table.setAlignRight(5);
  table.setAlignRight(6);
  table.setAlignRight(7);
  table.setAlignRight(8);
  table.setAlignRight(9);
  table.setAlignRight(10);
  console.log(table.toString());
}

function printUsage() {
  console.log(`Usage: pnpm -C src/packages/lite jupyter:bench:scroll -- [options]

Options:
  --base-url <url>          Full lite base URL (e.g. http://127.0.0.1:5173)
  --port <n>                Lite server port (uses connection-info host/protocol if available)
  --host <name>             Hostname with --port (default: localhost)
  --protocol <http|https>   Protocol with --port (default: http)
  --auth-token <token>      Auth token (default: from connection-info.json)
  --profile <quick|full>    Scenario profile (default: quick)
  --virtualization <mode>   Force notebook virtualization: on|off|keep (default: keep)
  --scenario <name>         Run one scenario from the selected profile
  --path-prefix <path>      Notebook path prefix (default: $HOME/jupyter-scroll-benchmark)
  --cycles <n>              Down/up scroll cycles per scenario (profile default)
  --scroll-steps <n>        Steps per directional scroll sweep (default: 42)
  --typing-chars <n>        Number of typed chars used for typing-latency metric; 0 disables typing probe (default: 40)
  --typing-timeout-ms <n>   Per-keystroke typing timeout in ms (default: 1500)
  --timeout-ms <n>          Per-scenario timeout in ms (default: 45000)
  --headed                  Run browser with UI (default: headless)
  --json                    Print raw JSON result
  --quiet                   Do not print per-scenario logs
  --help                    Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    profile: DEFAULT_PROFILE,
    virtualization: "keep",
    path_prefix: DEFAULT_PATH_PREFIX,
    scroll_steps: DEFAULT_SCROLL_STEPS,
    typing_chars: DEFAULT_TYPING_CHARS,
    typing_timeout_ms: DEFAULT_TYPING_TIMEOUT_MS,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    headless: true,
    json: false,
    quiet: false,
  };

  const args: string[] = [];
  for (const raw of argv) {
    const i = raw.indexOf("=");
    if (i > 0 && raw.startsWith("--")) {
      args.push(raw.slice(0, i), raw.slice(i + 1));
    } else {
      args.push(raw);
    }
  }

  let i = 0;
  const next = () => {
    i += 1;
    const v = args[i];
    if (v == null) {
      throw new Error(`missing value for ${args[i - 1]}`);
    }
    return v;
  };

  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case "--":
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      case "--base-url":
        opts.base_url = trimTrailingSlash(next());
        break;
      case "--port":
        opts.port = Number(next());
        if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
          throw new Error(`invalid --port '${opts.port}'`);
        }
        break;
      case "--host":
        opts.host = next();
        break;
      case "--protocol": {
        const protocol = next();
        if (protocol !== "http" && protocol !== "https") {
          throw new Error(`--protocol must be http or https, got '${protocol}'`);
        }
        opts.protocol = protocol;
        break;
      }
      case "--auth-token":
        opts.auth_token = next();
        break;
      case "--profile": {
        const profile = next();
        if (profile !== "quick" && profile !== "full") {
          throw new Error(`--profile must be quick or full, got '${profile}'`);
        }
        opts.profile = profile;
        break;
      }
      case "--virtualization": {
        const mode = next().toLowerCase();
        if (mode !== "on" && mode !== "off" && mode !== "keep") {
          throw new Error(
            `--virtualization must be on, off, or keep, got '${mode}'`,
          );
        }
        opts.virtualization = mode;
        break;
      }
      case "--scenario":
        opts.scenario = next();
        break;
      case "--path-prefix":
        opts.path_prefix = next();
        break;
      case "--cycles":
        opts.cycles = Number(next());
        if (!Number.isInteger(opts.cycles) || opts.cycles < 1) {
          throw new Error(`invalid --cycles '${opts.cycles}'`);
        }
        break;
      case "--scroll-steps":
        opts.scroll_steps = Number(next());
        if (!Number.isInteger(opts.scroll_steps) || opts.scroll_steps < 2) {
          throw new Error(`invalid --scroll-steps '${opts.scroll_steps}'`);
        }
        break;
      case "--typing-chars":
        opts.typing_chars = Number(next());
        if (!Number.isInteger(opts.typing_chars) || opts.typing_chars < 0) {
          throw new Error(`invalid --typing-chars '${opts.typing_chars}'`);
        }
        break;
      case "--typing-timeout-ms":
        opts.typing_timeout_ms = Number(next());
        if (
          !Number.isInteger(opts.typing_timeout_ms) ||
          opts.typing_timeout_ms < 100
        ) {
          throw new Error(
            `invalid --typing-timeout-ms '${opts.typing_timeout_ms}'`,
          );
        }
        break;
      case "--timeout-ms":
        opts.timeout_ms = Number(next());
        if (!Number.isInteger(opts.timeout_ms) || opts.timeout_ms < 2000) {
          throw new Error(`invalid --timeout-ms '${opts.timeout_ms}'`);
        }
        break;
      case "--headed":
        opts.headless = false;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      default:
        throw new Error(`unknown option '${a}'`);
    }
    i += 1;
  }

  return opts;
}

async function runScrollBenchmark(opts: Options): Promise<ScrollBenchmarkResult> {
  const started_at = new Date().toISOString();
  const { base_url, connection_info } = await resolveBaseUrl(opts);
  const auth_token = opts.auth_token ?? connection_info?.token;

  const scenarios = buildScenarios(opts);
  if (scenarios.length === 0) {
    throw new Error(
      `no scenarios matched profile='${opts.profile}' scenario='${opts.scenario ?? "*"}'`,
    );
  }

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const runs: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      await ensureNotebook(scenario.path_ipynb, scenario.cells);
      const url = notebookUrl({
        base_url,
        path_ipynb: scenario.path_ipynb,
        auth_token,
        virtualization: opts.virtualization,
      });
      const open_metrics = await openNotebookPage({
        page,
        url,
        timeout_ms: opts.timeout_ms,
      });
      const typing_metrics = await measureTypingScenario({
        page,
        chars: opts.typing_chars,
        typing_timeout_ms: opts.typing_timeout_ms,
        action_timeout_ms: opts.timeout_ms,
      });
      const cycles = opts.cycles ?? (opts.profile === "full" ? 4 : 2);
      const metrics = await measureScrollScenario({
        page,
        cycles,
        scroll_steps: opts.scroll_steps,
        top_marker: scenario.top_marker,
        bottom_marker: scenario.bottom_marker,
        timeout_ms: opts.timeout_ms,
      });
      const virtualization_likely =
        metrics.windowed_list_attr ??
        (metrics.dom_cells_mid < scenario.expected_cells * 0.6 ||
          metrics.dom_cells_bottom < scenario.expected_cells * 0.6);
      const virtualization_active = metrics.windowed_list_attr;
      const reliability_ok =
        metrics.top_marker_visible_after &&
        metrics.bottom_marker_visible_after &&
        metrics.max_scroll_px > 0;
      const run: ScenarioResult = {
        name: scenario.name,
        description: scenario.description,
        profile: opts.profile,
        path_ipynb: scenario.path_ipynb,
        expected_cells: scenario.expected_cells,
        cycles,
        scroll_steps: opts.scroll_steps,
        metrics,
        virtualization_likely,
        reliability_ok,
        virtualization_mode: opts.virtualization,
        virtualization_active,
        open_metrics,
        typing_metrics,
      };
      runs.push(run);

      if (!opts.quiet) {
        const fps = metrics.approx_fps == null ? "n/a" : metrics.approx_fps.toFixed(1);
        const typingP95 =
          typing_metrics.p95_ms == null ? "n/a" : `${typing_metrics.p95_ms.toFixed(1)}ms`;
        const status = reliability_ok ? "PASS" : "FAIL";
        console.log(
          `[jupyter-scroll-bench] ${scenario.name} (virt=${opts.virtualization}): open=${fmtMs(open_metrics.first_input_ms)}, typing_p95=${typingP95}, dur=${fmtMs(metrics.duration_ms)}, fps=${fps}, longtasks=${metrics.longtask_count}, status=${status}`,
        );
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return {
    ok: true,
    base_url,
    profile: opts.profile,
    virtualization: opts.virtualization,
    scenario_filter: opts.scenario,
    cycles: opts.cycles ?? (opts.profile === "full" ? 4 : 2),
    scroll_steps: opts.scroll_steps,
    typing_chars: opts.typing_chars,
    typing_timeout_ms: opts.typing_timeout_ms,
    timeout_ms: opts.timeout_ms,
    runs,
    started_at,
    finished_at: new Date().toISOString(),
  };
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = await runScrollBenchmark(opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printSummaryTable(result);
    printInteractionTable(result);
    printReliabilityMatrix(result);
    console.log(`base_url: ${result.base_url}`);
    console.log(`profile: ${result.profile}`);
    console.log(`virtualization: ${result.virtualization}`);
    console.log(`typing_chars: ${result.typing_chars}`);
    console.log(`typing_timeout_ms: ${result.typing_timeout_ms}`);
    if (result.scenario_filter) {
      console.log(`scenario: ${result.scenario_filter}`);
    }
  } catch (err: any) {
    console.error(`jupyter scroll benchmark failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}

void main();
