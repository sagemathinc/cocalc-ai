/*
A meeting's shared notes: many people type into the same Markdown file at
once, in the rich text editor (the default view) or in the source
(CodeMirror) editor, the way people use HackMD.

Each participant is a separate browser context on the same Lite server. They
type uniquely tagged words (tk<user>n<k>q) with real keystrokes at random
places, mostly into the same section, start new lines, and sometimes reload.
Afterwards every browser must show the same text, which must contain every
typed word exactly once.

Environment:
  COLLAB_BASE_URL   Lite server (default http://localhost:7001)
  COLLAB_HOME       the Lite project's home directory on this machine
  COLLAB_USERS      participants (default 10)
  COLLAB_SECONDS    how long they type (default 180)
  COLLAB_RELOADS    probability that an action is a reload (default 0.01)
  COLLAB_SEED       random seed (default: time)
  COLLAB_VIEW       "rich" (default) or "source"
  COLLAB_DEBUG      record the editors' merge/save decisions and, for each
                    lost word, report the first one that dropped it
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
const SEED = Number(process.env.COLLAB_SEED ?? Date.now() % 1_000_000);
const PROJECT_ID = "00000000-1000-4000-8000-000000000000";
const VIEW = process.env.COLLAB_VIEW ?? "rich";
const EDITOR = VIEW === "source" ? ".CodeMirror" : "[data-slate-editor]";
const TOKEN_RE = /tk\d+n\d+q/g;
const DEBUG = !!process.env.COLLAB_DEBUG;

interface DebugEvent {
  t: number;
  user: number;
  event: string;
  data: Record<string, any>;
}

// Which fields of each recorded decision are inputs, and which the output.
const DECISIONS: Record<string, { inputs: string[]; output: string }> = {
  "remote:merge": { inputs: ["remote", "observedLocal"], output: "merged" },
  "remote:adopt": { inputs: ["observedLocal"], output: "remote" },
  "preview:merge": { inputs: ["remote", "local"], output: "merged" },
  "save:merge": { inputs: ["observed", "current"], output: "result" },
  save: { inputs: ["editor", "current"], output: "saved" },
};

// The first recorded decision (by time) whose output has more copies of the
// token than any of its inputs.
function firstDuplication(token: string, events: DebugEvent[]) {
  const count = (v: unknown) => `${v ?? ""}`.split(token).length - 1;
  for (const e of events) {
    const spec = DECISIONS[e.event];
    if (!spec) continue;
    const out = count(e.data?.[spec.output]);
    const inputs = [...spec.inputs, "base", "last"].map((k) =>
      count(e.data?.[k]),
    );
    if (out > 1 && out > Math.max(...inputs)) return e;
  }
  return undefined;
}

// The first recorded decision (by time) that had the token in an input but
// not in its output.
function firstDrop(token: string, events: DebugEvent[]) {
  for (const e of events) {
    const spec = DECISIONS[e.event];
    if (!spec) continue;
    const out = `${e.data?.[spec.output] ?? ""}`;
    const had = spec.inputs.filter((k) =>
      `${e.data?.[k] ?? ""}`.includes(token),
    );
    if (had.length > 0 && !out.includes(token)) return { ...e, had };
  }
  return undefined;
}

function makeRng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

const AGENDA = [
  "# Jupyter dev meeting",
  "",
  "## Attendees",
  "",
  "## Agenda",
  "",
  "- Releases",
  "- Collaboration",
  "",
  "## Discussion",
  "",
  "## Action items",
  "",
].join("\n");

// Lite paths are absolute.
function fileUrl(path: string): string {
  return `${BASE}/projects/${PROJECT_ID}/files/%2F${encodeURI(path.slice(1))}`;
}

// What the editor shows: the source text, or the rich text's text.
async function shown(page: Page): Promise<string> {
  return await page.evaluate((view) => {
    if (view === "source") {
      const el = document.querySelector(".CodeMirror") as any;
      return el?.CodeMirror?.getValue() ?? "";
    }
    return (
      (document.querySelector("[data-slate-editor]") as HTMLElement)
        ?.innerText ?? ""
    );
  }, VIEW);
}

async function openNotes(page: Page, path: string): Promise<void> {
  await page.goto(fileUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(EDITOR, { timeout: 60_000 });
  // Let the sync session settle before typing (COLLAB_SETTLE_MS).
  await page.waitForTimeout(Number(process.env.COLLAB_SETTLE_MS ?? 3_000));
}

// Rich text: click a random block (mostly in Discussion), go to its end, type.
async function typeTokenRich(
  page: Page,
  rng: () => number,
  token: string,
): Promise<void> {
  const index = await page.evaluate((where) => {
    const root = document.querySelector("[data-slate-editor]");
    const blocks = Array.from(root?.children ?? []) as HTMLElement[];
    const text = blocks.map((b) => b.innerText.trim());
    const discussion = text.findIndex((t) => t.startsWith("Discussion"));
    const actions = text.findIndex((t) => t.startsWith("Action items"));
    if (where < 0.7 && discussion >= 0 && actions > discussion) {
      return discussion + Math.floor(Math.random() * (actions - discussion));
    }
    return Math.floor(Math.random() * blocks.length);
  }, rng());
  const block = page.locator("[data-slate-editor] > *").nth(index);
  await block.click({ timeout: 10_000 }).catch(() => undefined);
  // Put the caret at the end of the block's text. (The End key goes to the
  // end of the visual line, so on a wrapped line it could land in the middle
  // of another person's word, and the test would count that word as lost.)
  await page.evaluate((index) => {
    const block = document.querySelector("[data-slate-editor]")?.children[
      index
    ];
    if (block == null) return;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(
          "[data-slate-string], [data-slate-zero-width]",
        )
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    let last: Node | null = null;
    while (walker.nextNode()) last = walker.currentNode;
    if (last == null) return;
    const zeroWidth =
      last.parentElement?.closest("[data-slate-zero-width]") != null;
    window
      .getSelection()
      ?.collapse(last, zeroWidth ? 0 : (last.textContent ?? "").length);
  }, index);
  await page.waitForTimeout(20);
  if (rng() < 0.3) await page.keyboard.press("Enter");
  await page.keyboard.type(` ${token}`, { delay: 15 + Math.floor(rng() * 40) });
}

async function typeToken(
  page: Page,
  rng: () => number,
  token: string,
): Promise<void> {
  if (VIEW !== "source") return await typeTokenRich(page, rng, token);
  const where = rng();
  await page.evaluate(
    ({ where, newLine }) => {
      const cm = (document.querySelector(".CodeMirror") as any)?.CodeMirror;
      if (!cm) return;
      const lines: string[] = cm.getValue().split("\n");
      const discussion = lines.findIndex((l) => l.startsWith("## Discussion"));
      const actions = lines.findIndex((l) => l.startsWith("## Action items"));
      let line: number;
      if (where < 0.7 && discussion >= 0 && actions > discussion) {
        line =
          discussion +
          1 +
          Math.floor(Math.random() * (actions - discussion - 1));
      } else {
        line = Math.floor(Math.random() * lines.length);
      }
      cm.focus();
      cm.setCursor({ line, ch: lines[line]?.length ?? 0 });
      (window as any).__collabNewLine = newLine;
    },
    { where, newLine: rng() < 0.3 },
  );
  const newLine = await page.evaluate(() => (window as any).__collabNewLine);
  if (newLine) await page.keyboard.press("Enter");
  await page.keyboard.type(` ${token}`, { delay: 15 + Math.floor(rng() * 40) });
}

test("a meeting's notes stay consistent with many people typing", async ({
  browser,
}) => {
  const rng = makeRng(SEED);
  const path = join(HOME, `collab/meeting-${VIEW}-${SEED}.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, AGENDA);
  console.log(
    `seed ${SEED}, ${USERS} users, ${SECONDS}s, ${VIEW} view, file ${path}`,
  );

  const pages: Page[] = [];
  const debugEvents: DebugEvent[] = [];
  for (let u = 0; u < USERS; u++) {
    const context = await (browser as Browser).newContext();
    const page = await context.newPage();
    if (DEBUG) {
      await page.addInitScript(() => {
        (window as any).__slateDebugLog = true;
        (globalThis as any).__simpleInputMergeDebug = (
          event: string,
          data: unknown,
        ) => console.log("[collab-debug]" + JSON.stringify({ event, data }));
      });
      // CoCalc prefixes console messages with a timestamp, so look inside.
      page.on("console", (msg) => {
        const text = msg.text();
        const now = Date.now();
        const tag = text.indexOf("[collab-debug]");
        if (tag >= 0) {
          const { event, data } = JSON.parse(
            text.slice(tag + "[collab-debug]".length),
          );
          debugEvents.push({ t: now, user: u, event, data });
          return;
        }
        // The Slate editor's debug log also prints each entry as JSON.
        const json = text.indexOf('{"ts":');
        if (json >= 0 && text.includes('"type":"sync:')) {
          try {
            const entry = JSON.parse(text.slice(json));
            debugEvents.push({
              t: now,
              user: u,
              event: `${entry.type}`.replace(/^sync:/, ""),
              data: entry.data ?? {},
            });
          } catch {
            // not a complete entry
          }
        }
      });
    }
    await openNotes(page, path);
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
          await openNotes(page, path);
          continue;
        }
        const token = `tk${u}n${k++}q`;
        await typeToken(page, r, token);
        // Did it reach this participant's own editor? If not, the typing
        // missed the editor (a test problem), not the sync.
        const seen = await page
          .waitForFunction(
            ({ token, view }) => {
              const text =
                view === "source"
                  ? ((
                      document.querySelector(".CodeMirror") as any
                    )?.CodeMirror?.getValue() ?? "")
                  : ((
                      document.querySelector(
                        "[data-slate-editor]",
                      ) as HTMLElement
                    )?.innerText ?? "");
              return text.includes(token);
            },
            { token, view: VIEW },
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

  // Quiesce: wait until every browser shows the same text for a while.
  let values: string[] = [];
  let stableSince = 0;
  const quiesceDeadline = Date.now() + 120_000;
  while (Date.now() < quiesceDeadline) {
    const next = await Promise.all(pages.map(shown));
    const same = new Set(next).size === 1;
    if (same && next[0] === values[0]) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince > 8_000) break;
    } else {
      stableSince = 0;
    }
    values = next;
    await pages[0].waitForTimeout(1_000);
  }

  const distinct = new Set(values).size;
  const text = values[0] ?? "";
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
      distinctValues: distinct,
      lost: lost.length,
      duplicated: duplicated.length,
      lostSample: lost.slice(0, 10),
      duplicatedSample: duplicated.slice(0, 10),
    }),
  );
  if (DEBUG && duplicated.length > 0) {
    debugEvents.sort((a, b) => a.t - b.t);
    for (const token of duplicated) {
      const d = firstDuplication(token, debugEvents);
      console.log(
        d
          ? `${token}: duplicated at ${d.t - start}ms by user ${d.user} in ${d.event}`
          : `${token}: no recorded decision duplicated it`,
      );
    }
    await writeFile(`${path}.debug.json`, JSON.stringify(debugEvents));
  }
  if (DEBUG && lost.length > 0) {
    debugEvents.sort((a, b) => a.t - b.t);
    const drops = lost.map((token) => {
      const d = firstDrop(token, debugEvents);
      return d
        ? `${token}: dropped at ${d.t - start}ms by user ${d.user} in ${d.event} (had it in ${d.had.join(",")})`
        : `${token}: no recorded decision dropped it`;
    });
    console.log(drops.join("\n"));
    const counts = new Map<string, number>();
    for (const token of lost) {
      const d = firstDrop(token, debugEvents);
      const key = d ? d.event : "none";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(
      "drops by decision:",
      JSON.stringify(Object.fromEntries(counts)),
    );
    await writeFile(`${path}.debug.json`, JSON.stringify(debugEvents));
  }
  if (distinct > 1 || lost.length || duplicated.length) {
    await writeFile(
      `${path}.final.json`,
      JSON.stringify({ values, typed, missed, lost, events }, null, 1),
    );
  }
  expect(distinct).toBe(1);
  expect(lost).toEqual([]);
  expect(duplicated).toEqual([]);
});
