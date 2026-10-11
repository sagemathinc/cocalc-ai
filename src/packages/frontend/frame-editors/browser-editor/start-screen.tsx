/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What a web browser shows while it starts: a browser window taking shape
// (or the last picture of this browser, when there is one), the steps it is
// on, and a tip.  One look from opening the file until the first picture of
// the page, which it then fades into.

import { useEffect, useState } from "react";

export type BrowserStartStep = "project" | "browser" | "connecting";

const STEPS: { step: BrowserStartStep; doing: string; done: string }[] = [
  { step: "project", doing: "Starting the project", done: "Project ready" },
  { step: "browser", doing: "Starting Chromium", done: "Chromium ready" },
  { step: "connecting", doing: "Connecting", done: "Connected" },
];

const TIPS = [
  <>
    Agents drive; click <b>Take over</b> any time, then hand it back.
  </>,
  <>
    Copy and paste work as usual: <b>Ctrl+C</b> and <b>Ctrl+V</b> (
    <b>Cmd</b> on a Mac).
  </>,
  <>
    Sign in once: this browser keeps its sign-ins, encrypted for this project.
  </>,
  <>
    A site blocks cloud servers? Switch to <b>Runs on my computer</b>.
  </>,
  <>
    Click <b>Agent</b> and describe a task: the agent works in this browser
    while you watch.
  </>,
];

const CSS = `
.cc-bs { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; z-index:2;
  --cc-bs-fg:#1f2329; --cc-bs-muted:#6b7280; --cc-bs-line:#e5e7eb; --cc-bs-card:#fff; --cc-bs-soft:#f1f4f9; --cc-bs-sh1:#f1f4f9; --cc-bs-sh2:#e6ecf5;
  color:var(--cc-bs-fg); background:radial-gradient(1200px 600px at 50% 35%, #eef4ff 0%, #f8fafc 45%, #ffffff 100%);
  transition:opacity .35s ease; }
.cc-bs.cc-bs-done { opacity:0; pointer-events:none; }
@media (prefers-color-scheme: dark) {
  .cc-bs { --cc-bs-fg:#e6e6e6; --cc-bs-muted:#9aa3b2; --cc-bs-line:#30363d; --cc-bs-card:#161b22; --cc-bs-soft:#21262d; --cc-bs-sh1:#21262d; --cc-bs-sh2:#2d333b;
    background:radial-gradient(1200px 600px at 50% 35%, #12233f 0%, #0f141b 50%, #0d1117 100%); }
}
.cc-bs-wrap { display:flex; flex-direction:column; align-items:center; gap:24px; width:min(640px, 90%); }
.cc-bs-window { width:100%; aspect-ratio:16/9.5; max-height:60vh; border-radius:14px; background:var(--cc-bs-card); border:1px solid var(--cc-bs-line);
  box-shadow:0 24px 60px rgba(22,119,255,.14), 0 2px 8px rgba(0,0,0,.06); overflow:hidden; position:relative; display:flex; flex-direction:column; }
.cc-bs-tabs { height:30px; flex:none; background:var(--cc-bs-soft); display:flex; align-items:flex-end; padding:0 10px; }
.cc-bs-tab { height:23px; width:42%; max-width:180px; border-radius:8px 8px 0 0; background:var(--cc-bs-card); display:flex; align-items:center; gap:8px; padding:0 10px;
  font-size:12px; color:var(--cc-bs-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cc-bs-dot { width:11px; height:11px; flex:none; border-radius:50%; background:linear-gradient(135deg,#1677ff,#13c2c2); }
.cc-bs-bar { height:34px; flex:none; display:flex; align-items:center; gap:8px; padding:0 10px; border-bottom:1px solid var(--cc-bs-line); }
.cc-bs-btn { width:20px; height:20px; border-radius:6px; background:var(--cc-bs-soft); }
.cc-bs-url { flex:1; height:22px; border-radius:11px; background:var(--cc-bs-soft); }
.cc-bs-page { flex:1; position:relative; padding:22px 28px; }
.cc-bs-sk { border-radius:6px; margin-bottom:11px; background:linear-gradient(90deg,var(--cc-bs-sh1) 0%,var(--cc-bs-sh2) 40%,var(--cc-bs-sh1) 80%);
  background-size:200% 100%; animation:cc-bs-sh 1.4s infinite; }
@keyframes cc-bs-sh { from { background-position:200% 0 } to { background-position:-200% 0 } }
.cc-bs-picture { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:top left; filter:blur(1.5px) saturate(.9); opacity:.55; }
.cc-bs-hero { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:0 16px; text-align:center;
  background:color-mix(in srgb, var(--cc-bs-card) 70%, transparent); }
.cc-bs-globe { width:76px; height:76px; position:relative; flex:none; }
.cc-bs-globe svg { width:76px; height:76px; }
.cc-bs-ring { position:absolute; inset:-9px; border-radius:50%; border:2px solid transparent; border-top-color:#1677ff; border-right-color:#13c2c2; animation:cc-bs-spin 1.1s linear infinite; }
@keyframes cc-bs-spin { to { transform:rotate(360deg) } }
.cc-bs-title { margin:0; font-size:21px; font-weight:650; letter-spacing:-.01em; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cc-bs-sub { color:var(--cc-bs-muted); font-size:13px; }
.cc-bs-steps { display:flex; flex-wrap:wrap; justify-content:center; gap:8px 22px; font-size:13px; color:var(--cc-bs-muted); }
.cc-bs-step { display:flex; align-items:center; gap:8px; }
.cc-bs-step.cc-bs-now { color:var(--cc-bs-fg); font-weight:600; }
.cc-bs-ok { width:17px; height:17px; border-radius:50%; background:#52c41a; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
.cc-bs-spin { width:13px; height:13px; border-radius:50%; border:2px solid #1677ff; border-top-color:transparent; animation:cc-bs-spin .8s linear infinite; }
.cc-bs-todo { width:13px; height:13px; border-radius:50%; border:2px solid var(--cc-bs-line); }
.cc-bs-tip { font-size:12.5px; color:var(--cc-bs-muted); background:var(--cc-bs-card); border:1px solid var(--cc-bs-line); border-radius:999px; padding:6px 14px; text-align:center; }
.cc-bs-tip b { color:var(--cc-bs-fg); }
`;

let cssInstalled = false;
function installCss() {
  if (cssInstalled || typeof document === "undefined") return;
  cssInstalled = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const GLOBE = (
  <svg viewBox="0 0 64 64" fill="none" strokeWidth="2.4">
    <defs>
      <linearGradient id="cc-bs-globe" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#1677ff" />
        <stop offset="1" stopColor="#13c2c2" />
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="26" stroke="url(#cc-bs-globe)" />
    <ellipse cx="32" cy="32" rx="11" ry="26" stroke="url(#cc-bs-globe)" />
    <path d="M6 32h52M10 19h44M10 45h44" stroke="url(#cc-bs-globe)" />
  </svg>
);

export function BrowserStartScreen({
  name,
  step,
  picture,
  done = false,
}: {
  // The browser's name: the file's, or the chat's browser.
  name: string;
  step: BrowserStartStep;
  // The last picture of this browser, to resume where it was.
  picture?: string;
  // Fade out: the page is there.
  done?: boolean;
}) {
  installCss();
  const [tip, setTip] = useState(() =>
    Math.floor(Math.random() * TIPS.length),
  );
  useEffect(() => {
    const timer = setInterval(() => setTip((n) => (n + 1) % TIPS.length), 6000);
    return () => clearInterval(timer);
  }, []);
  const current = STEPS.findIndex((s) => s.step === step);
  return (
    <div
      className={`cc-bs${done ? " cc-bs-done" : ""}`}
      role="status"
      aria-label={`${STEPS[current]?.doing ?? "Starting"}: ${name}`}
    >
      <div className="cc-bs-wrap">
        <div className="cc-bs-window">
          <div className="cc-bs-tabs">
            <div className="cc-bs-tab">
              <span className="cc-bs-dot" />
              {picture ? name : "New tab"}
            </div>
          </div>
          <div className="cc-bs-bar">
            <span className="cc-bs-btn" />
            <span className="cc-bs-btn" />
            <span className="cc-bs-btn" />
            <span className="cc-bs-url" />
          </div>
          <div className="cc-bs-page">
            {picture ? (
              <img className="cc-bs-picture" src={picture} alt="" />
            ) : (
              <>
                <div className="cc-bs-sk" style={{ width: "46%", height: 20 }} />
                <div className="cc-bs-sk" style={{ width: "88%", height: 11 }} />
                <div className="cc-bs-sk" style={{ width: "80%", height: 11 }} />
                <div className="cc-bs-sk" style={{ width: "84%", height: 11 }} />
                <div style={{ display: "flex", gap: 14, marginTop: 16 }}>
                  <div className="cc-bs-sk" style={{ flex: 1, height: 90 }} />
                  <div className="cc-bs-sk" style={{ flex: 1, height: 90 }} />
                  <div className="cc-bs-sk" style={{ flex: 1, height: 90 }} />
                </div>
              </>
            )}
            <div className="cc-bs-hero">
              <div className="cc-bs-globe">
                <div className="cc-bs-ring" />
                {GLOBE}
              </div>
              <div className="cc-bs-title">{name}</div>
              <div className="cc-bs-sub">
                {picture
                  ? "Resuming where it was"
                  : "A real Chromium for you and your agents, running in your project"}
              </div>
            </div>
          </div>
        </div>
        <div className="cc-bs-steps">
          {STEPS.map((s, i) => (
            <div
              key={s.step}
              className={`cc-bs-step${i === current ? " cc-bs-now" : ""}`}
            >
              {i < current ? (
                <span className="cc-bs-ok">&#10003;</span>
              ) : i === current ? (
                <span className="cc-bs-spin" />
              ) : (
                <span className="cc-bs-todo" />
              )}
              {i < current ? s.done : s.doing}
            </div>
          ))}
        </div>
        <div className="cc-bs-tip">
          <b>Tip:</b> {TIPS[tip]}
        </div>
      </div>
    </div>
  );
}

// The last picture of each browser view, kept in this browser (IndexedDB) so
// that reopening it, even after a reload, starts from where it was.
const DB = "cocalc-browser-pictures";
const STORE = "pictures";
const MAX_PICTURES = 40;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined")
      return reject(Error("no indexedDB"));
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE).createIndex("at", "at");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadBrowserPicture(
  key: string,
): Promise<string | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result?.picture);
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function saveBrowserPicture(
  key: string,
  picture: string,
): Promise<void> {
  if (!picture.startsWith("data:image/") || picture.length > 400_000) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({ picture, at: Date.now() }, key);
    // Keep the newest few.
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_PICTURES;
      if (extra <= 0) return;
      store.index("at").openCursor().onsuccess = (event: any) => {
        const cursor = event.target.result;
        if (!cursor || extra-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    };
  } catch {
    // Pictures are a nicety.
  }
}
