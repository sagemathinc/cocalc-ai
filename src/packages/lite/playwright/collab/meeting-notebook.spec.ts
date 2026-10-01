/*
A meeting in a Jupyter notebook: many people type into the same notebook at
once, adding to its code cells and inserting new cells, the way a team
shares a notebook during a call.

Each participant is a separate browser context on the same Lite server. They
type uniquely tagged words (tk<user>n<k>q) with real keystrokes at the end of
random cells, start new lines, insert cells below (Esc, b, Enter), and
sometimes reload. Afterwards every browser must show the same cells, which
must contain every typed word exactly once.

Environment: as for meeting-markdown.spec.ts (COLLAB_BASE_URL, COLLAB_HOME,
COLLAB_USERS, COLLAB_SECONDS, COLLAB_RELOADS, COLLAB_SEED, COLLAB_SETTLE_MS),
plus
  COLLAB_QUIESCE_SECONDS  how long to wait for the browsers to agree (120)
  COLLAB_NEW_CELLS  probability that an action inserts a cell (default 0.1)
  COLLAB_DEBUG      record the merge decisions of cell inputs to
                    <notebook>.debug.json
*/

import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE = process.env.COLLAB_BASE_URL ?? "http://localhost:7001";
const HOME =
  process.env.COLLAB_HOME ?? join(process.env.HOME ?? "", "scratch/lite-bench");
const USERS = Number(process.env.COLLAB_USERS ?? 10);
const SECONDS = Number(process.env.COLLAB_SECONDS ?? 180);
const RELOADS = Number(process.env.COLLAB_RELOADS ?? 0.01);
const NEW_CELLS = Number(process.env.COLLAB_NEW_CELLS ?? 0.1);
const SEED = Number(process.env.COLLAB_SEED ?? Date.now() % 1_000_000);
const PROJECT_ID = "00000000-1000-4000-8000-000000000000";
const TOKEN_RE = /tk\d+n\d+q/g;
const DEBUG = !!process.env.COLLAB_DEBUG;
// COLLAB_DEBUG=idle records only after the typing stops: anything changing
// then is not caused by typing.
const DEBUG_IDLE = process.env.COLLAB_DEBUG === "idle";
const DEBUG_MAX = Number(process.env.COLLAB_DEBUG_MAX ?? 20_000);

function makeRng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

const NOTEBOOK = {
  cells: ["# Attendees", "# Agenda", "# Discussion", "# Action items"].map(
    (source) => ({
      cell_type: "code",
      metadata: {},
      source: [source],
      outputs: [],
      execution_count: null,
    }),
  ),
  metadata: {
    kernelspec: {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

// Lite paths are absolute.
function fileUrl(path: string): string {
  return `${BASE}/projects/${PROJECT_ID}/files/%2F${encodeURI(path.slice(1))}`;
}

// The cells' inputs in order, as "<cell id>: <input>". Cells are rendered
// lazily: one not scrolled into view yet is a placeholder without an editor,
// so show each first (see hydrateCells).
async function shown(page: Page): Promise<string[]> {
  await hydrateCells(page);
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-jupyter-lazy-cell-id]")).map(
      (el: any) => {
        const cm = el.querySelector(".CodeMirror") as any;
        const input = cm?.CodeMirror?.getValue() ?? "<not rendered>";
        return `${el.getAttribute("data-jupyter-lazy-cell-id")}: ${input}`;
      },
    ),
  );
}

async function hydrateCells(page: Page): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const left = await page.evaluate(() => {
      const placeholder = Array.from(
        document.querySelectorAll("[data-jupyter-lazy-cell-id]"),
      ).find((el) => el.querySelector(".CodeMirror") == null);
      placeholder?.scrollIntoView({ block: "center" });
      return placeholder != null;
    });
    if (!left) return;
    await page.waitForTimeout(50);
  }
}

const words = (cells: string[]) =>
  cells.map((text) => (text.match(TOKEN_RE) ?? []).join(" ")).join(" | ");

function installDebugHook(): void {
  (globalThis as any).__simpleInputMergeDebug = (
    event: string,
    data: unknown,
  ) => console.log("[collab-debug]" + JSON.stringify({ event, data }));
}

async function openNotebook(page: Page, path: string): Promise<void> {
  await page.goto(fileUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".CodeMirror", { timeout: 60_000 });
  await page.waitForTimeout(Number(process.env.COLLAB_SETTLE_MS ?? 3_000));
}

// Put the caret at the end of a random cell's input (in edit mode).
async function focusCellEnd(page: Page, where: number): Promise<boolean> {
  return await page.evaluate((where) => {
    const cells = Array.from(document.querySelectorAll(".CodeMirror")) as any[];
    if (cells.length === 0) return false;
    const cm = cells[Math.floor(where * cells.length)]?.CodeMirror;
    if (cm == null) return false;
    cm.focus();
    const last = cm.lastLine();
    cm.setCursor({ line: last, ch: cm.getLine(last).length });
    return true;
  }, where);
}

async function typeToken(
  page: Page,
  rng: () => number,
  token: string,
): Promise<void> {
  const delay = 15 + Math.floor(rng() * 40);
  if (!(await focusCellEnd(page, rng()))) return;
  // CodeMirror applies a programmatic caret move at once; give the notebook
  // a moment to switch the cell to edit mode.
  await page.waitForTimeout(100);
  if (rng() < NEW_CELLS) {
    // A new cell below this one, then type into it.
    await page.keyboard.press("Escape");
    await page.keyboard.press("b");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    await page.keyboard.type(token, { delay });
    return;
  }
  if (rng() < 0.3) await page.keyboard.press("Enter");
  await page.keyboard.type(` ${token}`, { delay });
}

test("a meeting's notebook stays consistent with many people typing", async ({
  browser,
}) => {
  // A new file each run: the server may still have an earlier run's
  // notebook of the same name open.
  const path = join(HOME, `collab/meeting-${SEED}-${Date.now()}.ipynb`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(NOTEBOOK));
  console.log(`seed ${SEED}, ${USERS} users, ${SECONDS}s, notebook ${path}`);

  const pages: Page[] = [];
  const errors: string[] = [];
  const debugEvents: { t: number; user: number; event: string; data: any }[] =
    [];
  for (let u = 0; u < USERS; u++) {
    const context = await (browser as Browser).newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => {
      if (errors.length < 50) errors.push(`u${u} pageerror: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error" && errors.length < 50) {
        errors.push(`u${u} console: ${msg.text().slice(0, 300)}`);
      }
    });
    if (DEBUG) {
      if (!DEBUG_IDLE) await page.addInitScript(installDebugHook);
      // CoCalc prefixes console messages with a timestamp, so look inside.
      page.on("console", (msg) => {
        const text = msg.text();
        const tag = text.indexOf("[collab-debug]");
        if (tag < 0 || debugEvents.length >= DEBUG_MAX) return;
        const { event, data } = JSON.parse(
          text.slice(tag + "[collab-debug]".length),
        );
        debugEvents.push({ t: Date.now(), user: u, event, data });
      });
    }
    await openNotebook(page, path);
    pages.push(page);
  }

  const typed: string[] = [];
  const missed: string[] = [];
  const events: string[] = [];
  const start = Date.now();
  const deadline = Date.now() + SECONDS * 1000;
  let reloads = 0;
  await Promise.all(
    pages.map(async (page, u) => {
      const r = makeRng(SEED * 31 + u);
      let k = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(100 + Math.floor(r() * 1500));
        if (r() < RELOADS) {
          reloads++;
          events.push(`${Date.now() - start} u${u} reload`);
          await openNotebook(page, path);
          continue;
        }
        const token = `tk${u}n${k++}q`;
        await typeToken(page, r, token);
        // Did it reach this participant's own notebook? If not, the typing
        // missed the editor (a test problem), not the sync.
        const seen = await page
          .waitForFunction(
            (token) =>
              Array.from(document.querySelectorAll(".CodeMirror")).some(
                (el: any) => (el.CodeMirror?.getValue() ?? "").includes(token),
              ),
            token,
            { timeout: 3_000 },
          )
          .then(() => true)
          .catch(() => false);
        (seen ? typed : missed).push(token);
        events.push(
          `${Date.now() - start} u${u} ${seen ? "typed" : "MISSED"} ${token}`,
        );
      }
    }),
  );

  if (DEBUG_IDLE) {
    // Installed only now: recording costs time, which would slow the typing.
    for (const page of pages) await page.evaluate(installDebugHook);
  }

  // Quiesce: wait until every browser shows the same cells for a while.
  let values: string[][] = [];
  let stableSince = 0;
  const quiesceStart = Date.now();
  const quiesceDeadline =
    Date.now() + 1000 * Number(process.env.COLLAB_QUIESCE_SECONDS ?? 120);
  let lastReport = 0;
  while (Date.now() < quiesceDeadline) {
    const next = await Promise.all(pages.map(shown));
    if (Date.now() - lastReport > 15_000) {
      lastReport = Date.now();
      console.log(
        `quiesce ${Math.round((Date.now() - quiesceStart) / 1000)}s: ${
          new Set(next.map((cells) => JSON.stringify(cells))).size
        } distinct, cells ${next.map((cells) => cells.length).join(",")}`,
      );
    }
    const same = new Set(next.map((cells) => JSON.stringify(cells))).size === 1;
    if (same && JSON.stringify(next[0]) === JSON.stringify(values[0])) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince > 8_000) break;
    } else {
      stableSince = 0;
    }
    values = next;
    await pages[0].waitForTimeout(1_000);
  }

  const distinct = new Set(values.map((cells) => JSON.stringify(cells))).size;
  const text = (values[0] ?? []).join("\n");
  const counts = new Map<string, number>();
  for (const t of text.match(TOKEN_RE) ?? [])
    counts.set(t, (counts.get(t) ?? 0) + 1);
  const lost = typed.filter((t) => !counts.has(t));
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([t]) => t);
  console.log(
    JSON.stringify({
      seed: SEED,
      users: USERS,
      typed: typed.length,
      missed: missed.length,
      reloads,
      cells: values[0]?.length,
      distinctValues: distinct,
      distinctWords: new Set(values.map(words)).size,
      lost: lost.length,
      duplicated: duplicated.length,
      errors: errors.length,
      lostSample: lost.slice(0, 10),
      duplicatedSample: duplicated.slice(0, 10),
    }),
  );
  if (errors.length) console.log(errors.slice(0, 10).join("\n"));
  if (distinct > 1 || lost.length || duplicated.length) {
    await writeFile(
      `${path}.final.json`,
      JSON.stringify({ values, typed, missed, lost, events, errors }, null, 1),
    );
  }
  if (DEBUG) {
    await writeFile(`${path}.debug.json`, JSON.stringify(debugEvents));
  }
  expect(distinct).toBe(1);
  expect(lost).toEqual([]);
  expect(duplicated).toEqual([]);
});
