/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The shared browser viewer's look: a browser window (tabs, an address bar)
// around the page, in the start screen's colors (see ../start-screen.tsx).

const CSS = `
.cc-sbv { --bg:#fff; --fg:#1f1f1f; --muted:#666; --bar:#f3f3f3; --line:#d9d9d9; --accent:#1677ff; --warn:#fff4d6; --warnfg:#5c3d00; --tab:#e8e8e8; --sp1:#eef4ff; --sp2:#f8fafc;
  display:flex; flex-direction:column; width:100%; height:100%; min-height:0; background:var(--bg); color:var(--fg); font:13px system-ui, sans-serif; overflow:hidden; }
@media (prefers-color-scheme: dark) {
  .cc-sbv { --bg:#141414; --fg:#e6e6e6; --muted:#9a9a9a; --bar:#1f1f1f; --line:#333; --accent:#4c8dff; --warn:#3a2f12; --warnfg:#ffd77a; --tab:#2a2a2a; --sp1:#12233f; --sp2:#0f141b; }
}
.cc-sbv button { font:inherit; }
.cc-sbv-tabs { display:flex; gap:2px; padding:4px 6px 0; background:var(--bar); overflow-x:auto; flex:none; }
.cc-sbv-tab { display:flex; align-items:center; gap:6px; max-width:200px; padding:4px 8px; border-radius:6px 6px 0 0; background:var(--tab); cursor:pointer; white-space:nowrap; }
.cc-sbv-tab.cc-sbv-active { background:var(--bg); }
.cc-sbv-tab span { overflow:hidden; text-overflow:ellipsis; }
.cc-sbv-tab img { width:14px; height:14px; flex:none; }
.cc-sbv-tab button, .cc-sbv-newtab { border:none; background:none; color:var(--muted); cursor:pointer; padding:0 2px; font-size:13px; }
.cc-sbv-nav { display:flex; gap:4px; align-items:center; padding:4px 6px; background:var(--bg); border-bottom:1px solid var(--line); flex:none; }
.cc-sbv-nav button { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:2px 8px; cursor:pointer; }
.cc-sbv-nav button.cc-sbv-off { opacity:.45; }
.cc-sbv-nav .cc-sbv-shutdown { color:#cf1322; border-color:#ffa39e; }
.cc-sbv-zoom { display:flex; }
.cc-sbv-zoom button { padding:2px 7px; border-radius:0; margin-left:-1px; }
.cc-sbv-zoom button:first-child { border-radius:4px 0 0 4px; margin-left:0; }
.cc-sbv-zoom button:last-child { border-radius:0 4px 4px 0; }
.cc-sbv-zoom .cc-sbv-zoomlevel { min-width:46px; font-variant-numeric:tabular-nums; }
.cc-sbv-zoom.cc-sbv-zoomed .cc-sbv-zoomlevel { color:var(--accent); font-weight:600; }
.cc-sbv-nav select { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:2px 4px; font:inherit; }
.cc-sbv-url { flex:1; min-width:0; padding:3px 8px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--fg); font:inherit; }
.cc-sbv-driver { display:flex; align-items:center; gap:8px; padding:4px 8px; border-bottom:1px solid var(--line); flex:none; }
.cc-sbv-driver.cc-sbv-ask, .cc-sbv-driver.cc-sbv-waiting { background:var(--warn); color:var(--warnfg); }
.cc-sbv-driver.cc-sbv-agent { background:var(--accent); color:#fff; }
.cc-sbv-driver.cc-sbv-agent button { background:#fff; color:var(--accent); }
.cc-sbv-driver .cc-sbv-msg { flex:1; min-width:0; }
.cc-sbv-driver button { border:none; border-radius:4px; padding:4px 12px; background:var(--accent); color:#fff; cursor:pointer; font-weight:600; }
.cc-sbv-stage { position:relative; flex:1; min-height:0; background:var(--bg); }
.cc-sbv-screen { position:absolute; inset:0; width:100%; height:100%; outline:none; opacity:0; transition:opacity .3s ease; }
.cc-sbv-screen.cc-sbv-shown { opacity:1; }
.cc-sbv-screen.cc-sbv-view-only { cursor:not-allowed; }
.cc-sbv-keys { position:absolute; left:0; top:0; width:1px; height:1px; opacity:0; border:0; padding:0; margin:0; resize:none; overflow:hidden; pointer-events:none; }
.cc-sbv-overlay { position:absolute; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.25); z-index:2; }
.cc-sbv-overlay button { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:4px 10px; cursor:pointer; }
.cc-sbv-row { display:flex; gap:6px; justify-content:flex-end; }
.cc-sbv-hint { position:absolute; left:50%; top:12px; transform:translateX(-50%); background:rgba(0,0,0,.75); color:#fff; padding:6px 12px; border-radius:6px; z-index:3; }
.cc-sbv-notdriving { left:50%; top:50%; transform:translate(-50%,-50%); padding:16px 20px; text-align:center; max-width:80%; z-index:3; }
.cc-sbv-notdriving p { margin:0 0 12px; font-size:14px; }
.cc-sbv-overlay.cc-sbv-notdriving button { border:none; padding:6px 16px; background:var(--accent); color:#fff; font-weight:600; font-size:14px; }
.cc-sbv-waiting { left:50%; top:40px; transform:translateX(-50%); padding:14px 16px; width:min(560px, 90%); }
.cc-sbv-waiting p { margin:0 0 10px; line-height:1.4; }
.cc-sbv-waiting pre { white-space:pre-wrap; word-break:break-all; background:var(--bar); border:1px solid var(--line); border-radius:4px; padding:8px; margin:0 0 10px; font-size:12px; }
.cc-sbv-overlay button.cc-sbv-primary { background:var(--accent); color:#fff; border:none; font-weight:600; }
.cc-sbv-dialog { left:50%; top:40px; transform:translateX(-50%); padding:12px; min-width:280px; max-width:80%; }
.cc-sbv-dialog pre { white-space:pre-wrap; margin:0 0 8px; font:inherit; }
.cc-sbv-dialog input, .cc-sbv-filechooser input { width:100%; box-sizing:border-box; margin-bottom:8px; font:inherit; }
.cc-sbv-select { max-height:60%; overflow:auto; padding:4px 0; min-width:160px; }
.cc-sbv-select div { padding:3px 12px; cursor:pointer; }
.cc-sbv-select div:hover, .cc-sbv-select div.cc-sbv-sel { background:var(--accent); color:#fff; }
.cc-sbv-select div.cc-sbv-dis { opacity:.45; cursor:default; }
.cc-sbv-select div.cc-sbv-grp { font-weight:600; cursor:default; }
.cc-sbv-filechooser { left:50%; top:40px; transform:translateX(-50%); padding:12px; width:360px; max-width:90%; }
.cc-sbv-copied { right:12px; bottom:28px; padding:10px 12px; max-width:320px; }
.cc-sbv-copied p { margin:0 0 8px; }
.cc-sbv-status { position:absolute; right:8px; bottom:6px; font-size:11px; color:#fff; background:rgba(0,0,0,.5); padding:1px 6px; border-radius:4px; pointer-events:none; }
/* A new tab's start page. */
.cc-sbv-start { position:absolute; inset:0; overflow:auto; background:radial-gradient(1100px 520px at 50% 18%, var(--sp1) 0%, var(--sp2) 50%, var(--bg) 100%); }
.cc-sbv-sp { display:flex; flex-direction:column; align-items:center; gap:20px; padding:56px 16px 32px; max-width:680px; margin:0 auto; }
.cc-sbv-sp-logo { display:flex; align-items:center; gap:12px; max-width:100%; }
.cc-sbv-sp-logo svg { width:46px; height:46px; flex:none; }
.cc-sbv-sp-logo h1 { margin:0; font-size:28px; font-weight:650; letter-spacing:-.02em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
.cc-sbv-sp-form { width:100%; height:48px; box-sizing:border-box; border-radius:24px; background:var(--bg); border:1px solid var(--line); box-shadow:0 8px 28px rgba(22,119,255,.10); display:flex; align-items:center; gap:10px; padding:0 18px; margin:0; }
.cc-sbv-sp-form input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--fg); font:16px system-ui, sans-serif; }
.cc-sbv-sp-section { width:100%; }
.cc-sbv-sp-label { font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 8px 4px; }
.cc-sbv-sp-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.cc-sbv-sp-tile { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; cursor:pointer; min-width:0; text-align:left; color:var(--fg); font:inherit; }
.cc-sbv-sp-tile:hover { border-color:var(--accent); box-shadow:0 4px 14px rgba(22,119,255,.12); }
.cc-sbv-sp-tile b, .cc-sbv-sp-tile small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cc-sbv-sp-tile b { font-size:13px; }
.cc-sbv-sp-tile small { color:var(--muted); font-size:11.5px; }
.cc-sbv-sp-tile img { width:22px; height:22px; border-radius:4px; }
.cc-sbv-sp-badge { height:22px; min-width:22px; width:fit-content; padding:0 6px; box-sizing:border-box; border-radius:6px; color:#fff; font-weight:700; font-size:11.5px; display:flex; align-items:center; justify-content:center; }
.cc-sbv-sp-live { display:flex; align-items:center; gap:5px; }
.cc-sbv-sp-live:before { content:""; width:7px; height:7px; border-radius:50%; background:#52c41a; flex:none; }
.cc-sbv-sp-agent { width:100%; box-sizing:border-box; display:flex; align-items:center; gap:10px; background:linear-gradient(135deg,#1677ff,#13a8c2); color:#fff; border-radius:14px; padding:12px 14px; margin:0; }
.cc-sbv-sp-agent input { flex:1; min-width:0; border:0; outline:0; background:rgba(255,255,255,.18); color:#fff; border-radius:8px; padding:8px 10px; font:inherit; }
.cc-sbv-sp-agent input::placeholder { color:rgba(255,255,255,.82); }
.cc-sbv-sp-agent button { border:0; background:#fff; color:#1677ff; font-weight:650; border-radius:8px; padding:7px 14px; cursor:pointer; }
.cc-sbv-sp-hints { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; color:var(--muted); font-size:12px; }
.cc-sbv-sp-hints span { background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:4px 11px; }
.cc-sbv-sp-hints a { color:var(--accent); cursor:pointer; }
.cc-sbv-sp-network { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 10px; padding:10px 12px; border:1px dashed var(--line); border-radius:12px; color:var(--muted); font-size:12.5px; }
.cc-sbv-sp-network span { flex:1; min-width:200px; }
.cc-sbv-sp-network button { border:0; background:var(--accent); color:#fff; font-weight:600; border-radius:8px; padding:6px 12px; cursor:pointer; }
.cc-sbv kbd { font:11px ui-monospace, monospace; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; }
`;

let installed = false;

export function installViewerCss(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}
