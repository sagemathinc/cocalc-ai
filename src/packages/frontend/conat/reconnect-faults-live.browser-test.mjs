// Live fault-injection harness: do open editors survive backend restarts and
// network drops WITHOUT being torn down and recreated?
//
// It loads the app once, opens a text file, a Jupyter notebook and a terminal
// inside it, tags each editor's root element, keeps typing into the text
// editor, injects one fault, waits for recovery, and then checks:
//   - no remount: every tagged editor root is still the same DOM node
//     (a remount replaces it, and the tag is gone);
//   - no lost edits: every line typed during the fault is in the editor and,
//     after saving, on disk (read back with the cocalc CLI if configured);
//   - the terminal answers a fresh command;
//   - no recovery banner or "Editor recovered" message appeared;
//   - how long until the text editor shows its content as saved again.
//
// Usage:
//   CDP_URL=http://localhost:9222 SITE=https://staging2.cocalc.dev \
//   PROJECT_ID=<uuid> DIR=reconnect FAULT=offline:15 \
//   node reconnect-faults-live.browser-test.mjs
//
// FAULT is one of:
//   offline:<seconds>   drop the browser's network (DevTools protocol)
//   cmd:<shell command> run a command that restarts something, e.g.
//                       cmd:ssh ubuntu@host 'sudo pkill -f "^project-host:conat-router$"'
//   none                no fault (baseline)
// Optional: VERIFY_CMD="cocalc --profile staging2 project file cat -w <id>"
// is run with the text file's path (relative to home) appended, to check that
// the edits reached the file on disk.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const SITE = process.env.SITE ?? "https://staging2.cocalc.dev";
const PROJECT_ID = process.env.PROJECT_ID;
const DIR = process.env.DIR ?? "reconnect";
const FAULT = process.env.FAULT ?? "offline:15";
const RECOVERY_TIMEOUT_MS = Number(process.env.RECOVERY_TIMEOUT_MS ?? 120000);
const FILES = {
  text: "notes.txt",
  markdown: "notes.md",
  notebook: "nb.ipynb",
  terminal: "shell.term",
};
// After recovery, keep watching this long for a late teardown: the browser
// learns of a new host session only when it next refreshes routing.
const OBSERVE_SECONDS = Number(process.env.OBSERVE_SECONDS ?? 180);
if (!PROJECT_ID) throw new Error("PROJECT_ID is required");

const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const context = browser.contexts()[0];
const page = await context.newPage();
page.setDefaultTimeout(30000);
const nonce = `rcx-${Date.now().toString(36)}`;
const report = { fault: FAULT, nonce, checks: {}, notes: [] };
const consoleCounts = {};
page.on("console", (msg) => {
  const text = msg.text();
  for (const key of [
    "failed to fetch acp log",
    "getAllFromPersist - failed",
    "cross-site connection refused",
    "Editor recovered",
    // Logged for every open file when the project's runtime is torn down
    // (resetProjectHostRuntime -> project_file.remove).
    "removeByName",
  ]) {
    if (text.includes(key)) consoleCounts[key] = (consoleCounts[key] ?? 0) + 1;
  }
});

function fileUrl(name) {
  return `${SITE}/projects/${PROJECT_ID}/files/home/user/${DIR}/${name}`;
}

// Open a file inside the running app, without a page reload: push the URL and
// let the app's router handle popstate, as browser history navigation does.
// (A synthetic <a> click reloads the whole app.)
async function openInApp(name) {
  const path = new URL(fileUrl(name)).pathname;
  await page.evaluate((path) => {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, path);
}

// The element whose identity marks "this editor was not remounted". For a
// notebook the per-cell CodeMirrors come and go as cells scroll, so use the
// cell list container instead.
const ROOT_SELECTOR = {
  text: ".CodeMirror",
  markdown: ".CodeMirror",
  notebook: "[data-jupyter-windowed-list]",
  terminal: ".xterm",
};

async function tagVisibleEditor(kind) {
  return await page.evaluate(
    ({ kind, selector, nonce }) => {
      const els = [...document.querySelectorAll(selector)].filter(
        (e) => (e.offsetWidth || e.offsetHeight) && !e.dataset.rcx,
      );
      window.__rcxRoots ??= [];
      window.__rcxRemoved ??= [];
      for (const e of els) {
        e.dataset.rcx = `${nonce}:${kind}`;
        window.__rcxRoots.push({ kind, el: e });
      }
      // Poll the identity of every tagged root once a second and record when
      // one leaves the document (a remount replaces it).
      window.__rcxPoll ??= setInterval(() => {
        for (const r of window.__rcxRoots) {
          if (!r.gone && !r.el.isConnected) {
            r.gone = new Date().toISOString();
            window.__rcxRemoved.push({ kind: r.kind, at: r.gone });
          }
        }
      }, 1000);
      return els.length;
    },
    { kind, selector: ROOT_SELECTOR[kind], nonce },
  );
}

async function survivingTags() {
  return await page.evaluate((nonce) => {
    const found = {};
    for (const e of document.querySelectorAll("[data-rcx]")) {
      if (e.dataset.rcx.startsWith(nonce))
        found[e.dataset.rcx.split(":")[1]] = true;
    }
    return found;
  }, nonce);
}

async function typeInText(line) {
  await page.evaluate((line) => {
    const cm = [...document.querySelectorAll(".CodeMirror")].find(
      (e) =>
        e.dataset.rcx?.endsWith(":text") && (e.offsetWidth || e.offsetHeight),
    )?.CodeMirror;
    if (!cm) throw new Error("text editor not found or not visible");
    const doc = cm.getDoc();
    doc.replaceRange(`${line}\n`, { line: doc.lastLine() + 1, ch: 0 });
  }, line);
}

async function textEditorValue() {
  return await page.evaluate(() => {
    const cm = [...document.querySelectorAll(".CodeMirror")].find((e) =>
      e.dataset.rcx?.endsWith(":text"),
    )?.CodeMirror;
    return cm?.getValue() ?? null;
  });
}

// Watch for any recovery banner / alert that appears during the run.
async function installBannerWatch() {
  await page.evaluate(() => {
    window.__rcxBanners = [];
    const re = /restart|reconnect|recover|disconnected|reload/i;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el =
            n.closest?.(".ant-alert, .ant-message, .ant-notification") ??
            n.querySelector?.(
              ".ant-alert, .ant-message-notice, .ant-notification-notice",
            );
          const text = (el?.innerText ?? "").slice(0, 200);
          if (el && re.test(text)) window.__rcxBanners.push(text);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

async function injectFault() {
  if (FAULT === "none") return;
  if (FAULT.startsWith("offline:")) {
    const seconds = Number(FAULT.slice("offline:".length));
    await context.setOffline(true);
    for (let i = 0; i < seconds; i++) {
      await typeInText(`typed while offline ${i}`).catch((err) =>
        report.notes.push(`type failed while offline: ${err.message}`),
      );
      await page.waitForTimeout(1000);
    }
    await context.setOffline(false);
    return;
  }
  if (FAULT.startsWith("cmd:")) {
    const cmd = FAULT.slice("cmd:".length);
    const typing = (async () => {
      for (let i = 0; i < 10; i++) {
        await typeInText(`typed during fault ${i}`).catch((err) =>
          report.notes.push(`type failed during fault: ${err.message}`),
        );
        await page.waitForTimeout(1000);
      }
    })();
    try {
      execSync(cmd, { stdio: "pipe", timeout: 120000 });
    } catch (err) {
      report.notes.push(`fault command failed: ${err.message.slice(0, 300)}`);
    }
    await typing;
    return;
  }
  throw new Error(`unknown FAULT ${FAULT}`);
}

let exitCode = 0;
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(fileUrl(FILES.text), { waitUntil: "domcontentloaded" });
  await page.locator(".CodeMirror").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  // Marks this page load; a full reload of the app loses it.
  await page.evaluate((nonce) => (window.__rcxPageLoad = nonce), nonce);
  await tagVisibleEditor("text");
  for (const kind of ["markdown", "notebook", "terminal"]) {
    await openInApp(FILES[kind]);
    await page.waitForTimeout(6000);
    const n = await tagVisibleEditor(kind);
    if (!n) report.notes.push(`no visible editor root for ${kind}`);
  }
  await openInApp(FILES.text);
  await page.waitForTimeout(3000);
  const before = await survivingTags();
  report.tagsBeforeFault = before;
  if (!before.text) {
    report.notes.push("the text editor did not survive a plain tab switch");
    // Re-tag so the fault phase still measures something useful.
    await tagVisibleEditor("text");
  }
  await installBannerWatch();
  await typeInText(`before fault ${nonce}`);

  const faultStart = Date.now();
  await injectFault();
  const faultEnd = Date.now();
  await typeInText(`after fault ${nonce}`);

  // Recovery: the text editor shows every typed line and the save state is
  // clean again.
  let recoveredAt = null;
  while (Date.now() - faultEnd < RECOVERY_TIMEOUT_MS) {
    const value = (await textEditorValue()) ?? "";
    const saved = await page
      .getByText("Saved", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    if (value.includes(`after fault ${nonce}`) && saved) {
      recoveredAt = Date.now();
      break;
    }
    await page.waitForTimeout(1000);
  }
  report.recovery_seconds =
    recoveredAt == null ? null : Math.round((recoveredAt - faultEnd) / 1000);
  report.fault_seconds = Math.round((faultEnd - faultStart) / 1000);

  // Keep working in the active editor for a while: a teardown can come late,
  // when the browser next refreshes the host's routing and sees a new host
  // session.
  for (let t = 0; t < OBSERVE_SECONDS; t += 10) {
    await typeInText(`observing ${t}s ${nonce}`).catch((err) =>
      report.notes.push(`type failed while observing at ${t}s: ${err.message}`),
    );
    await page.waitForTimeout(10000);
  }
  report.removed_roots = await page.evaluate(() => window.__rcxRemoved ?? []);

  const after = await survivingTags();
  const value = (await textEditorValue()) ?? "";
  const typed = value
    .split("\n")
    .filter((l) =>
      /typed (while offline|during fault)|(before|after) fault/.test(l),
    );
  report.checks.no_page_reload = await page.evaluate(
    (nonce) => window.__rcxPageLoad === nonce,
    nonce,
  );
  // The active editor must never have left the document, not even briefly.
  report.checks.no_remount_text =
    !!after.text && !report.removed_roots.some((r) => r.kind === "text");
  report.checks.recovered = recoveredAt != null;
  report.checks.edits_in_editor =
    value.includes(`before fault ${nonce}`) &&
    value.includes(`after fault ${nonce}`);
  report.typed_lines_in_editor = typed.length;

  if (process.env.VERIFY_CMD && recoveredAt != null) {
    await page.waitForTimeout(5000);
    // VERIFY_CMD takes a path relative to the project's home directory.
    try {
      const onDisk = execSync(
        `${process.env.VERIFY_CMD} ${DIR}/${FILES.text}`,
        {
          encoding: "utf8",
          timeout: 60000,
        },
      );
      report.checks.edits_on_disk = onDisk.includes(`after fault ${nonce}`);
    } catch (err) {
      report.checks.edits_on_disk = false;
      report.notes.push(`VERIFY_CMD failed: ${`${err.message}`.slice(0, 300)}`);
    }
  }

  // The other editors: revisit each and see whether its root survived.
  await openInApp(FILES.markdown);
  await page.waitForTimeout(4000);
  report.checks.no_remount_markdown = !!(await survivingTags()).markdown;
  await openInApp(FILES.notebook);
  await page.waitForTimeout(4000);
  report.checks.no_remount_notebook = !!(await survivingTags()).notebook;
  // The notebook still runs code and shows the output: catches a kernel,
  // runtime-state or live-run output stream that stays stuck after recovery.
  const cellMarker = `rcx-cell-${Date.now()}`;
  const ranAt = Date.now();
  await page.evaluate((code) => {
    const list = document.querySelector("[data-jupyter-windowed-list]");
    const cm = [...(list?.querySelectorAll(".CodeMirror") ?? [])].find(
      (e) => e.offsetWidth || e.offsetHeight,
    )?.CodeMirror;
    if (!cm) throw new Error("no visible notebook cell editor");
    cm.setValue(code);
    cm.focus();
  }, `print("${cellMarker}")`);
  await page.keyboard.press("Shift+Enter");
  report.checks.notebook_runs = await page
    .waitForFunction(
      (marker) => {
        const list = document.querySelector("[data-jupyter-windowed-list]");
        // The marker appears once in the input; a second time means output.
        return (list?.innerText.split(marker).length ?? 0) - 1 >= 2;
      },
      cellMarker,
      { timeout: 90000 },
    )
    .then(() => true)
    .catch(() => false);
  report.notebook_run_seconds = report.checks.notebook_runs
    ? Math.round((Date.now() - ranAt) / 1000)
    : null;

  await openInApp(FILES.terminal);
  await page.waitForTimeout(4000);
  report.checks.no_remount_terminal = !!(await survivingTags()).terminal;
  // Terminal answers a new command.
  const marker = `rcx-term-${Date.now()}`;
  await page.locator(".xterm").first().click();
  await page.keyboard.type(`echo ${marker}\n`);
  report.checks.terminal_responds = await page
    .locator(".xterm")
    .first()
    .getByText(marker)
    .nth(1)
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  report.banners = await page.evaluate(() => window.__rcxBanners ?? []);
  report.checks.no_banner = report.banners.length === 0;
  report.console = consoleCounts;
  const failed = Object.entries(report.checks).filter(([, ok]) => !ok);
  report.result = failed.length ? "FAIL" : "PASS";
  if (failed.length) exitCode = 1;
} catch (error) {
  report.result = "ERROR";
  report.error = `${error?.stack ?? error}`.slice(0, 2000);
  exitCode = 2;
} finally {
  console.log(JSON.stringify(report, null, 2));
  await page.close().catch(() => {});
  // Never close the browser: over CDP that can close the human's browser.
  process.exit(exitCode);
}
