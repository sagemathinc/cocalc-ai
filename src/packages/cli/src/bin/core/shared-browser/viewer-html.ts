// The viewer page served by the shared browser and embedded in the chat card.
// Plain HTML and JS: no build step, no dependencies.
export const VIEWER_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared browser</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f1f1f; --muted:#666; --bar:#f3f3f3; --line:#d9d9d9; --accent:#1677ff; --warn:#fff4d6; --warnfg:#5c3d00; --tab:#e8e8e8; --sp1:#eef4ff; --sp2:#f8fafc; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#e6e6e6; --muted:#9a9a9a; --bar:#1f1f1f; --line:#333; --accent:#4c8dff; --warn:#3a2f12; --warnfg:#ffd77a; --tab:#2a2a2a; --sp1:#12233f; --sp2:#0f141b; } }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:13px system-ui, sans-serif; overflow:hidden; }
  #app { display:flex; flex-direction:column; height:100%; }
  #tabs { display:flex; gap:2px; padding:4px 6px 0; background:var(--bar); overflow-x:auto; }
  .tab { display:flex; align-items:center; gap:6px; max-width:200px; padding:4px 8px; border-radius:6px 6px 0 0; background:var(--tab); cursor:pointer; white-space:nowrap; }
  .tab.active { background:var(--bg); }
  .tab span { overflow:hidden; text-overflow:ellipsis; }
  .tab img { width:14px; height:14px; flex:none; }
  .tab button, #newtab { border:none; background:none; color:var(--muted); cursor:pointer; padding:0 2px; font-size:13px; }
  #nav { display:flex; gap:4px; align-items:center; padding:4px 6px; background:var(--bg); border-bottom:1px solid var(--line); }
  #nav button { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:2px 8px; cursor:pointer; }
  #nav button.off { opacity:.45; }
  #nav #shutdown { color:#cf1322; border-color:#ffa39e; }
  #runson, #quality { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:2px 4px; }
  #url { flex:1; min-width:0; padding:3px 8px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--fg); }
  #driver { display:flex; align-items:center; gap:8px; padding:4px 8px; border-bottom:1px solid var(--line); }
  #driver.ask, #driver.waiting { background:var(--warn); color:var(--warnfg); }
  #driver.agent { background:var(--accent); color:#fff; }
  #driver.agent button { background:#fff; color:var(--accent); }
  #waiting { left:50%; top:40px; transform:translateX(-50%); padding:14px 16px; display:none; width:min(560px, 90%); }
  #waiting p { margin:0 0 10px; line-height:1.4; }
  #waiting pre { white-space:pre-wrap; word-break:break-all; background:var(--bar); border:1px solid var(--line); border-radius:4px; padding:8px; margin:0 0 10px; font-size:12px; }
  #waiting button { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:4px 10px; cursor:pointer; }
  #waiting button[data-a="copy"] { background:var(--accent); color:#fff; border:none; font-weight:600; }
  #notdriving { left:50%; top:50%; transform:translate(-50%,-50%); padding:16px 20px; text-align:center; display:none; max-width:80%; }
  #notdriving p { margin:0 0 12px; font-size:14px; }
  #notdriving button { border:none; border-radius:4px; padding:6px 16px; background:var(--accent); color:#fff; cursor:pointer; font-weight:600; font-size:14px; }
  #driver .msg { flex:1; min-width:0; }
  #driver button { border:none; border-radius:4px; padding:4px 12px; background:var(--accent); color:#fff; cursor:pointer; font-weight:600; }
  #stage { position:relative; flex:1; min-height:0; background:var(--bg); }
  #screen { position:absolute; inset:0; width:100%; height:100%; outline:none; opacity:0; transition:opacity .3s ease; }
  #screen.shown { opacity:1; }
  /* A new tab's start page. */
  #start { position:absolute; inset:0; overflow:auto; display:none; background:radial-gradient(1100px 520px at 50% 18%, var(--sp1) 0%, var(--sp2) 50%, var(--bg) 100%); }
  .sp { display:flex; flex-direction:column; align-items:center; gap:20px; padding:56px 16px 32px; max-width:680px; margin:0 auto; }
  .sp-logo { display:flex; align-items:center; gap:12px; max-width:100%; }
  .sp-logo svg { width:46px; height:46px; flex:none; }
  .sp-logo h1 { margin:0; font-size:28px; font-weight:650; letter-spacing:-.02em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #sp-form { width:100%; height:48px; box-sizing:border-box; border-radius:24px; background:var(--bg); border:1px solid var(--line); box-shadow:0 8px 28px rgba(22,119,255,.10); display:flex; align-items:center; gap:10px; padding:0 18px; }
  #sp-form input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--fg); font:16px system-ui, sans-serif; }
  .sp-section { width:100%; display:none; }
  .sp-label { font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 8px 4px; }
  .sp-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
  .sp-tile { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; cursor:pointer; min-width:0; text-align:left; color:var(--fg); font:inherit; }
  .sp-tile:hover { border-color:var(--accent); box-shadow:0 4px 14px rgba(22,119,255,.12); }
  .sp-tile b, .sp-tile small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sp-tile b { font-size:13px; }
  .sp-tile small { color:var(--muted); font-size:11.5px; }
  .sp-tile img { width:22px; height:22px; border-radius:4px; }
  .sp-badge { height:22px; min-width:22px; width:fit-content; padding:0 6px; box-sizing:border-box; border-radius:6px; color:#fff; font-weight:700; font-size:11.5px; display:flex; align-items:center; justify-content:center; }
  .sp-live { display:flex; align-items:center; gap:5px; }
  .sp-live:before { content:""; width:7px; height:7px; border-radius:50%; background:#52c41a; flex:none; }
  #sp-agent { width:100%; box-sizing:border-box; display:none; align-items:center; gap:10px; background:linear-gradient(135deg,#1677ff,#13a8c2); color:#fff; border-radius:14px; padding:12px 14px; }
  #sp-agent input { flex:1; min-width:0; border:0; outline:0; background:rgba(255,255,255,.18); color:#fff; border-radius:8px; padding:8px 10px; font:inherit; }
  #sp-agent input::placeholder { color:rgba(255,255,255,.82); }
  #sp-agent button { border:0; background:#fff; color:#1677ff; font-weight:650; border-radius:8px; padding:7px 14px; cursor:pointer; }
  .sp-hints { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; color:var(--muted); font-size:12px; }
  .sp-hints span { background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:4px 11px; }
  kbd { font:11px ui-monospace, monospace; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; }
  #screen.view-only { cursor:not-allowed; }
  #hint { position:absolute; left:50%; top:12px; transform:translateX(-50%); background:rgba(0,0,0,.75); color:#fff; padding:6px 12px; border-radius:6px; display:none; }
  .overlay { position:absolute; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.25); }
  #dialog { left:50%; top:40px; transform:translateX(-50%); padding:12px; min-width:280px; max-width:80%; display:none; }
  #dialog pre { white-space:pre-wrap; margin:0 0 8px; font:inherit; }
  #dialog input, #filechooser input { width:100%; box-sizing:border-box; margin-bottom:8px; }
  .row { display:flex; gap:6px; justify-content:flex-end; }
  #select { max-height:60%; overflow:auto; display:none; padding:4px 0; min-width:160px; }
  #select div { padding:3px 12px; cursor:pointer; }
  #select div:hover, #select div.sel { background:var(--accent); color:#fff; }
  #select div.dis { opacity:.45; cursor:default; }
  #select div.grp { font-weight:600; cursor:default; }
  #filechooser { left:50%; top:40px; transform:translateX(-50%); padding:12px; width:360px; display:none; }
  #keys { position:absolute; left:0; top:0; width:1px; height:1px; opacity:0; border:0; padding:0; margin:0; resize:none; overflow:hidden; pointer-events:none; }
  #copied { right:12px; bottom:28px; padding:10px 12px; display:none; max-width:320px; }
  #copied p { margin:0 0 8px; }
  #status { position:absolute; right:8px; bottom:6px; font-size:11px; color:#fff; background:rgba(0,0,0,.5); padding:1px 6px; border-radius:4px; }
</style>
</head>
<body>
<div id="app">
  <div id="tabs"></div>
  <div id="nav">
    <button id="back" title="Back">&#8592;</button>
    <button id="fwd" title="Forward">&#8594;</button>
    <button id="reload" title="Reload">&#8635;</button>
    <input id="url" spellcheck="false" placeholder="Address or search">
    <select id="runson" title="Where this browser runs" style="display:none">
      <option value="project">Runs in the project</option><option value="computer">Runs on my computer</option>
    </select>
    <select id="quality" title="Picture quality: Sharp sends crisp text once the page is still; Fast uses less bandwidth">
      <option value="sharp">Sharp</option><option value="balanced">Balanced</option><option value="fast">Fast</option>
    </select>
    <button id="copy" title="Copy the selected text to your clipboard" style="display:none">Copy</button>
    <button id="forget" title="Sign every web browser in this project out of all websites" style="display:none">Forget sign-ins</button>
    <button id="shutdown" title="Shut down this browser (agents cannot use it until it is started again)" style="display:none">Shut down</button>
  </div>
  <div id="driver"><span class="msg"></span><button></button></div>
  <div id="stage">
    <canvas id="screen"></canvas>
    <!-- Takes the keyboard: a text field gets paste, copy and input-method
         events everywhere (iPad included); a canvas does not.  It holds the
         page's selection, selected, so a copy copies that. -->
    <textarea id="keys" tabindex="-1" aria-hidden="true" inputmode="none" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
    <div id="start"><div class="sp">
      <div class="sp-logo"><svg viewBox="0 0 64 64" fill="none" stroke-width="2.6"><defs><linearGradient id="spg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1677ff"/><stop offset="1" stop-color="#13c2c2"/></linearGradient></defs><circle cx="32" cy="32" r="26" stroke="url(#spg)"/><ellipse cx="32" cy="32" rx="11" ry="26" stroke="url(#spg)"/><path d="M6 32h52M10 19h44M10 45h44" stroke="url(#spg)"/></svg><h1 id="sp-name"></h1></div>
      <form id="sp-form"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="sp-q" placeholder="Search the web or type an address" spellcheck="false" autocomplete="off"></form>
      <div id="sp-servers" class="sp-section"><div class="sp-label">Running in this project</div><div class="sp-tiles"></div></div>
      <div id="sp-recent" class="sp-section"><div class="sp-label">Recent</div><div class="sp-tiles"></div></div>
      <form id="sp-agent"><b>Ask an agent</b><input placeholder="e.g. test the sign-up flow on localhost:5173 and report bugs"><button>Start</button></form>
      <div class="sp-hints"><span id="sp-keys"><kbd>Ctrl+C</kbd> <kbd>Ctrl+V</kbd> copy and paste</span><span>Take over and hand back any time</span><span id="sp-computer">Sites that block cloud servers: Runs on my computer</span></div>
    </div></div>
    <div id="hint"></div>
    <div id="notdriving" class="overlay"><p></p><button>Take over</button></div>
    <div id="waiting" class="overlay"><p><b>Waiting for your computer.</b> This browser runs in Chrome on your computer, so sites see your network and your logins. Run this there (it needs the CoCalc CLI); a Chrome window opens, and stays connected while it runs:</p><pre></pre><div class="row"><button data-a="project">Run it in the project instead</button><button data-a="copy">Copy command</button></div></div>
    <div id="dialog" class="overlay"><pre></pre><input><div class="row"><button data-a="0">Cancel</button><button data-a="1">OK</button></div></div>
    <div id="select" class="overlay"></div>
    <div id="filechooser" class="overlay"><div style="margin-bottom:6px">Upload a project file (path relative to your home directory):</div><input placeholder="e.g. Documents/report.pdf"><div class="row"><button data-a="0">Cancel</button><button data-a="1">Upload</button></div></div>
    <div id="copied" class="overlay"><p>The page copied text.</p><div class="row"><button data-a="0">Dismiss</button><button data-a="1">Copy it</button></div></div>
    <div id="status">connecting...</div>
  </div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("screen"), ctx = canvas.getContext("2d"), stage = $("stage"), keys = $("keys");
  let ws = null, state = null, retry = 0, lastPointer = { x: 20, y: 20 };
  // A browser on the user's computer: they use its window; this is a preview.
  const preview = () => state && state.runsOn === "computer";
  const human = () => state && state.driver === "human" && !preview();
  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function basePath() {
    let path = location.pathname.replace(/\/index\.html$/, "/");
    if (!path.endsWith("/")) path += "/";
    return path;
  }
  function wsUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + basePath() + "viewer" + location.search;
  }
  const iconUrl = (url) => basePath() + "favicon?url=" + encodeURIComponent(url);
  function connect() {
    ws = new WebSocket(wsUrl());
    ws.binaryType = "blob";
    ws.onopen = () => { retry = 0; $("status").textContent = "live"; visible = null; updateVisible(); sendSize(true); };
    ws.onclose = () => {
      $("status").textContent = "reconnecting...";
      setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    };
    ws.onmessage = async (ev) => {
      if (typeof ev.data !== "string") {
        try { const bmp = await createImageBitmap(ev.data); drawFrame(bmp); saveFrame(ev.data); ready(); schedulePicture(); } catch {}
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") { state = msg.state; render(); }
      else if (msg.type === "selection") { selection = msg.text || ""; mirror(); showCopy(); }
      else if (msg.type === "copied") pageCopied(msg.text || "");
      else if (msg.type === "error") flash(msg.message);
    };
  }

  // The last frame, kept per view so a hidden or reloaded viewer shows it at
  // once and then updates.
  const viewKey = "cocalc-browser-frame:" + location.pathname + ":" + (new URLSearchParams(location.search).get("view") || "");
  let saveTimer = null, lastBlob = null;
  function saveFrame(blob) {
    lastBlob = blob;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const reader = new FileReader();
      reader.onload = () => { try { sessionStorage.setItem(viewKey, reader.result); } catch {} };
      reader.readAsDataURL(lastBlob);
    }, 2000);
  }
  (function restoreFrame() {
    let data = null;
    try { data = sessionStorage.getItem(viewKey); } catch {}
    if (!data) return;
    const img = new Image();
    img.onload = () => { if (!lastFrame) createImageBitmap(img).then(drawFrame).catch(() => {}); };
    img.src = data;
  })();

  let lastFrame = null;
  const background = () => getComputedStyle(stage).backgroundColor;
  function drawFrame(bmp) {
    // Redrawing the current frame (e.g. on resize) must not close it first.
    if (lastFrame && lastFrame !== bmp && lastFrame.close) lastFrame.close();
    lastFrame = bmp;
    canvas.classList.add("shown");
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = background(); ctx.fillRect(0, 0, w, h);
    // Frames are rendered at the viewport size, which follows this canvas.
    const scale = Math.min(w / bmp.width, h / bmp.height);
    // Frames come at the canvas's device pixels: draw them 1:1 when they fit.
    ctx.imageSmoothingEnabled = Math.abs(scale - 1) > 0.01;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, bmp.width * scale, bmp.height * scale);
  }

  // A hidden view (another tab or frame in front, a background browser tab)
  // keeps its last frame and must not resize the page to nothing.
  let visible = null;
  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    send({ type: "visible", visible: v });
    if (v) sendSize(true);
  }
  function tooSmall() { const r = stage.getBoundingClientRect(); return r.width < 40 || r.height < 40; }
  function updateVisible() { setVisible(!document.hidden && !tooSmall()); }
  document.addEventListener("visibilitychange", updateVisible);

  // Picture quality: a display preference of this device.
  const QUALITY_KEY = "cocalc-browser-quality";
  function quality() { try { return localStorage.getItem(QUALITY_KEY) || "balanced"; } catch { return "balanced"; } }
  $("quality").value = quality();
  $("quality").addEventListener("change", () => { try { localStorage.setItem(QUALITY_KEY, $("quality").value); } catch {} sendSize(true); focusKeys(); });
  // Moving the window to a screen with another pixel ratio.
  (function watchRatio() {
    const mq = matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)");
    mq.addEventListener("change", () => { sendSize(true); watchRatio(); }, { once: true });
  })();

  let sizeTimer = null, lastSize = "";
  function sendSize(force) {
    if (tooSmall()) { updateVisible(); return; }
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    if (lastFrame) drawFrame(lastFrame);
    const key = Math.round(r.width) + "x" + Math.round(r.height) + "@" + dpr + quality();
    if (!force && key === lastSize) return;
    lastSize = key;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => send({ type: "resize", width: Math.round(r.width), height: Math.round(r.height), scale: dpr, quality: quality() }), 150);
  }
  new ResizeObserver(() => { updateVisible(); sendSize(false); }).observe(stage);

  function render() {
    // tabs
    const tabs = $("tabs"); tabs.textContent = "";
    for (const tab of state.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === state.active ? " active" : "");
      if (tab.icon) {
        const icon = document.createElement("img");
        icon.src = iconUrl(tab.icon); icon.alt = "";
        icon.onerror = () => icon.remove();
        el.appendChild(icon);
      }
      const label = document.createElement("span");
      const blank = !tab.url || tab.url === "about:blank";
      label.textContent = blank ? "New tab" : tab.title || tab.url; el.title = blank ? "New tab" : tab.url;
      el.appendChild(label);
      el.onclick = () => send({ type: "tab", id: tab.id });
      if (human()) {
        const close = document.createElement("button"); close.textContent = "×"; close.title = "Close tab";
        close.onclick = (e) => { e.stopPropagation(); send({ type: "closeTab", id: tab.id }); };
        el.appendChild(close);
      }
      tabs.appendChild(el);
    }
    if (human()) { const plus = document.createElement("button"); plus.id = "newtab"; plus.textContent = "+"; plus.title = "New tab"; plus.onclick = () => send({ type: "newTab" }); tabs.appendChild(plus); }
    const active = state.tabs.find((t) => t.id === state.active);
    if (document.activeElement !== $("url")) $("url").value = active ? (active.url === "about:blank" ? "" : active.url) : "";
    for (const id of ["back", "fwd", "reload"]) $(id).classList.toggle("off", !human());
    $("url").readOnly = !human();
    // driver banner
    const bar = $("driver"), msg = bar.querySelector(".msg"), button = bar.querySelector("button");
    bar.className = human() ? (state.agentWaiting ? "waiting" : "") : state.ask ? "ask" : state.agents ? "agent" : "";
    if (preview()) {
      msg.textContent = "Running in Chrome on your computer: use that window. This is a preview." +
        (state.driver === "human" ? " The agent waits until you hand back." : state.agents ? " The agent is using it." : "");
      button.textContent = state.driver === "human" ? "Hand back to agent" : "Pause the agent";
      $("notdriving").style.display = "none";
    } else if (human()) {
      msg.textContent = state.agentWaiting ? "You are driving. The agent is waiting to use the browser."
        : "You are driving." + (state.agents ? " The agent waits until you hand back." : "");
      button.textContent = "Hand back to agent";
      $("notdriving").style.display = "none";
    } else {
      msg.textContent = state.ask ? "The agent asks you to take over: " + state.ask.message
        : state.agents ? "The agent is driving." : "No agent connected. Take over to use the browser.";
      button.textContent = "Take over";
    }
    canvas.classList.toggle("view-only", !human());
    $("quality").style.display = preview() ? "none" : "";
    // Where a .browser file's browser runs, and waiting for the computer.
    const runson = $("runson");
    runson.style.display = state.runsOn ? "" : "none";
    // On the user's computer, sign-ins are that Chrome's own business.
    $("forget").style.display = window.parent !== window && !preview() ? "" : "none";
    showCopy();
    if (state.runsOn && document.activeElement !== runson) runson.value = state.runsOn;
    const waiting = $("waiting");
    const waitingForComputer = state.connection === "waiting" && state.runsOn === "computer";
    // In a .browser editor the page draws this panel itself (with how to
    // install the CoCalc CLI); tell it what to show.
    const hostPanel = new URLSearchParams(location.search).get("panel") === "host";
    waiting.style.display = waitingForComputer && !hostPanel ? "block" : "none";
    if (window.parent !== window)
      window.parent.postMessage({ type: "cocalc-browser-state", runsOn: state.runsOn, connection: state.connection, connectCommand: state.connectCommand }, "*");
    waiting.querySelector("pre").textContent = state.connectCommand || "";
    if (state.connection === "waiting" && lastFrame) { ctx.fillStyle = background(); ctx.fillRect(0, 0, canvas.width, canvas.height); lastFrame = null; }
    if (waitingForComputer) ready();
    // overlays (only meaningful while the human drives)
    const dlg = $("dialog");
    if (state.dialog && human()) {
      dlg.style.display = "block";
      dlg.querySelector("pre").textContent = state.dialog.message;
      const input = dlg.querySelector("input");
      input.style.display = state.dialog.type === "prompt" ? "" : "none";
      if (state.dialog.type === "prompt" && !input.dataset.init) { input.value = state.dialog.defaultPrompt || ""; input.dataset.init = "1"; }
      dlg.querySelector('[data-a="0"]').style.display = state.dialog.type === "alert" ? "none" : "";
    } else { dlg.style.display = "none"; delete dlg.querySelector("input").dataset.init; }
    renderSelect();
    $("filechooser").style.display = state.fileChooser && human() ? "block" : "none";
    renderStart();
  }
  // In CoCalc, the page asks for confirmation and stops the app.
  if (window.parent !== window) {
    $("shutdown").style.display = "";
    $("shutdown").onclick = () => window.parent.postMessage({ type: "cocalc-app-shutdown" }, "*");
    $("forget").onclick = () => window.parent.postMessage({ type: "cocalc-browser-forget" }, "*");
  }
  $("runson").addEventListener("change", () => send({ type: "runsOn", value: $("runson").value }));
  // The page's panel may switch it back to the project.
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "cocalc-browser-runs-on") return;
    if (e.data.value === "project" || e.data.value === "computer") send({ type: "runsOn", value: e.data.value });
  });
  $("waiting").addEventListener("click", (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (a === "project") send({ type: "runsOn", value: "project" });
    else if (a === "copy") {
      const text = (state && state.connectCommand) || "";
      const done = () => flash("Copied. Run it in a terminal on your computer.");
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => flash("Select the command and copy it."));
      else flash("Select the command and copy it.");
    }
  });
  $("driver").querySelector("button").onclick = () => send({ type: state && state.driver === "human" ? "handback" : "takeover" });
  // Using the browser without driving does nothing: say why, right where
  // the user looked, with the way out.
  let notDrivingTimer;
  function notDriving() {
    const box = $("notdriving");
    box.querySelector("p").textContent = preview()
      ? "This browser runs in Chrome on your computer: use that window. This is a preview."
      : state && state.agents
        ? "The agent is driving this browser, so your clicks and typing are ignored."
        : "Take over to use this browser.";
    box.querySelector("button").style.display = preview() ? "none" : "";
    box.style.display = "block";
    clearTimeout(notDrivingTimer);
    notDrivingTimer = setTimeout(() => (box.style.display = "none"), 5000);
  }
  $("notdriving").querySelector("button").onclick = () => { $("notdriving").style.display = "none"; send({ type: "takeover" }); focusKeys(); };
  $("dialog").addEventListener("click", (e) => {
    const a = e.target.dataset && e.target.dataset.a; if (a == null) return;
    send({ type: "dialog", accept: a === "1", promptText: $("dialog").querySelector("input").value });
  });
  $("filechooser").addEventListener("click", (e) => {
    const a = e.target.dataset && e.target.dataset.a; if (a == null) return;
    const value = $("filechooser").querySelector("input").value.trim();
    send({ type: "file", paths: a === "1" && value ? value.split(",").map((s) => s.trim()) : [] });
  });

  function renderSelect() {
    const box = $("select");
    if (!state.select || !human()) { box.style.display = "none"; return; }
    box.textContent = "";
    let group;
    state.select.options.forEach((o, i) => {
      if (o.group && o.group !== group) { group = o.group; const g = document.createElement("div"); g.className = "grp"; g.textContent = group; box.appendChild(g); }
      const el = document.createElement("div");
      el.textContent = o.label; el.className = (i === state.select.selected ? "sel " : "") + (o.disabled ? "dis" : "");
      if (!o.disabled) el.onclick = () => send({ type: "select", index: i });
      box.appendChild(el);
    });
    const r = stage.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = Math.min(lastPointer.x, r.width - 180) + "px";
    box.style.top = Math.min(lastPointer.y + 8, r.height - 80) + "px";
  }

  let hintTimer;
  function flash(text) { const h = $("hint"); h.textContent = text; h.style.display = "block"; clearTimeout(hintTimer); hintTimer = setTimeout(() => (h.style.display = "none"), 2500); }

  // --- input ---------------------------------------------------------------
  // The browser runs on Linux: on a Mac or iPad, Cmd does what Ctrl does there.
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
  const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey || (apple && e.metaKey) ? 2 : 0) | (e.metaKey && !apple ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const accel = (e) => (apple ? e.metaKey : e.ctrlKey) && !e.altKey;
  const BUTTONS = ["left", "middle", "right"];
  function point(e) {
    const r = canvas.getBoundingClientRect();
    lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    const vw = state ? state.viewport.width : r.width, vh = state ? state.viewport.height : r.height;
    const scale = Math.min(r.width / vw, r.height / vh) || 1;
    return { x: lastPointer.x / scale, y: lastPointer.y / scale };
  }
  function mouse(event, e, extra) {
    if (!human()) { if (event === "mousePressed") notDriving(); return; }
    const p = point(e);
    send(Object.assign({ type: "mouse", event, x: p.x, y: p.y, modifiers: mods(e), buttons: e.buttons }, extra));
  }
  canvas.addEventListener("mousedown", (e) => { focusKeys(); if (state && state.select) send({ type: "select", index: -1 }); mouse("mousePressed", e, { button: BUTTONS[e.button] || "left", clickCount: e.detail || 1 }); e.preventDefault(); });
  canvas.addEventListener("mouseup", (e) => mouse("mouseReleased", e, { button: BUTTONS[e.button] || "left", clickCount: e.detail || 1 }));
  let moveQueued = null;
  canvas.addEventListener("mousemove", (e) => {
    if (!human()) return;
    if (moveQueued) { moveQueued = e; return; }
    moveQueued = e;
    requestAnimationFrame(() => { const ev = moveQueued; moveQueued = null; mouse("mouseMoved", ev, { button: ev.buttons & 1 ? "left" : "none" }); });
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  const SPECIAL = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  function key(event, e) {
    const shortcut = accel(e) ? e.key.toLowerCase() : "";
    // Copy and cut: the system's copy event takes the page's selection (see
    // below), driving or not; the page gets the keys too, for its own copy
    // handlers (and so a cut deletes there).
    if (shortcut === "c" || shortcut === "x") { if (human()) sendKey(event, e); return; }
    // Paste arrives as a paste event.
    if (shortcut === "v") return;
    if (!human()) { if (event === "keyDown") notDriving(); return; }
    // An input method or a virtual keyboard: the text arrives as input.
    if (e.isComposing || e.key === "Unidentified" || e.keyCode === 229) return;
    e.preventDefault();
    sendKey(event, e);
  }
  function sendKey(event, e) {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
    // The browser's own key code is the Windows virtual key code CDP wants.
    // (A character's code is not: "(" is 40, which is ArrowDown.)
    const keyCode = e.keyCode || SPECIAL[e.key] || (/^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase().charCodeAt(0) : 0);
    send({ type: "key", event: event === "keyDown" ? (text ? "keyDown" : "rawKeyDown") : "keyUp", key: e.key, code: e.code, text: event === "keyDown" ? text : undefined, keyCode, modifiers: mods(e) });
  }
  keys.addEventListener("keydown", (e) => key("keyDown", e));
  keys.addEventListener("keyup", (e) => key("keyUp", e));
  let composing = false;
  keys.addEventListener("compositionstart", () => (composing = true));
  keys.addEventListener("compositionend", (e) => { composing = false; if (human() && e.data) send({ type: "text", text: e.data }); mirror(); });
  // Text that came without a key (dictation, a virtual keyboard).
  keys.addEventListener("input", (e) => {
    if (composing) return;
    if (human() && e.inputType === "insertText" && e.data) send({ type: "text", text: e.data });
    mirror();
  });
  document.addEventListener("paste", (e) => { if (document.activeElement !== keys || !human()) return; e.preventDefault(); send({ type: "text", text: e.clipboardData.getData("text") }); });

  // --- clipboard -------------------------------------------------------------
  // The page's selection, kept selected in the keyboard's field.
  let selection = "", copyText = null, localCopy = { text: "", at: 0 };
  function focusKeys() { keys.focus({ preventScroll: true }); mirror(); }
  function mirror() {
    if (composing) return;
    if (keys.value !== selection) keys.value = selection;
    if (document.activeElement === keys) keys.select();
  }
  function showCopy() { $("copy").style.display = selection && !preview() ? "" : "none"; }
  for (const type of ["copy", "cut"])
    document.addEventListener(type, (e) => {
      if (document.activeElement !== keys) return;
      e.preventDefault();
      const text = copyText != null ? copyText : selection;
      if (!text) return;
      e.clipboardData.setData("text/plain", text);
      localCopy = { text, at: Date.now() };
    });
  // Within a click or a key press.
  function copy(text) {
    localCopy = { text, at: Date.now() };
    const fallback = () => {
      copyText = text; keys.value = text; keys.focus({ preventScroll: true }); keys.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      copyText = null; mirror();
      return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    return fallback();
  }
  $("copy").onclick = () => { copy(selection).then(() => flash("Copied"), () => flash("Could not copy: press " + (apple ? "Cmd" : "Ctrl") + "+C")); focusKeys(); };
  // The page copied something (its copy button): to the clipboard, or, where
  // that needs a click of the user's own (Safari), offer one.
  let copiedTimer;
  function pageCopied(text) {
    if (!text || (text === localCopy.text && Date.now() - localCopy.at < 3000)) return;
    if (!document.hasFocus()) return;
    const offer = () => {
      const box = $("copied");
      box.dataset.text = text;
      box.style.display = "block";
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (box.style.display = "none"), 15000);
    };
    localCopy = { text, at: Date.now() };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => flash("Copied"), offer);
    else offer();
  }
  $("copied").addEventListener("click", (e) => {
    const a = e.target.dataset && e.target.dataset.a; if (a == null) return;
    const box = $("copied");
    box.style.display = "none";
    if (a === "1") copy(box.dataset.text || "").then(() => flash("Copied"), () => flash("Could not copy"));
    focusKeys();
  });

  $("url").addEventListener("mousedown", () => { if (!human()) notDriving(); });
  $("url").addEventListener("keydown", (e) => { if (e.key === "Enter") { send({ type: "navigate", url: $("url").value }); focusKeys(); } });
  const navButton = (id, msg) => { $(id).onclick = () => (human() ? send(msg) : notDriving()); };
  navButton("back", { type: "history", delta: -1 });
  navButton("fwd", { type: "history", delta: 1 });
  navButton("reload", { type: "reload" });

  // --- for the page around it (CoCalc) ----------------------------------------
  // The page shows its own start screen until this shows something.
  let readySent = false;
  function ready() {
    if (readySent || window.parent === window) return;
    readySent = true;
    window.parent.postMessage({ type: "cocalc-browser-ready" }, "*");
  }
  // A small picture of this view now and then, for the page to start from
  // next time.
  let pictureAt = 0, pictureTimer = null;
  function postPicture() {
    clearTimeout(pictureTimer); pictureTimer = null;
    if (window.parent === window || !lastFrame || !state || blankTab() || preview()) return;
    pictureAt = Date.now();
    try {
      const w = Math.min(640, lastFrame.width), h = Math.round(lastFrame.height * w / lastFrame.width);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(lastFrame, 0, 0, w, h);
      window.parent.postMessage({ type: "cocalc-browser-picture", picture: c.toDataURL("image/jpeg", 0.6) }, "*");
    } catch {}
  }
  function schedulePicture() {
    if (!pictureTimer) pictureTimer = setTimeout(postPicture, Math.max(0, pictureAt + 5000 - Date.now()));
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) postPicture(); });

  // --- a new tab's start page --------------------------------------------------
  if (new URLSearchParams(location.search).get("agent") === "1") $("sp-agent").style.display = "flex";
  if (apple) $("sp-keys").innerHTML = "<kbd>&#8984;C</kbd> <kbd>&#8984;V</kbd> copy and paste";
  function blankTab() {
    const tab = state && state.tabs.find((t) => t.id === state.active);
    return !!tab && (!tab.url || tab.url === "about:blank");
  }
  let startShown = false, startLoadedAt = 0;
  function renderStart() {
    const show = blankTab() && !preview() && state.connection === "connected";
    $("start").style.display = show ? "block" : "none";
    $("sp-name").textContent = state.title || "Web browser";
    $("sp-computer").style.display = state.runsOn ? "" : "none";
    if (show) ready();
    if (show && !startShown) {
      if (Date.now() - startLoadedAt > 3000) loadStart();
      if (human()) $("sp-q").focus({ preventScroll: true });
    }
    startShown = show;
  }
  const COLORS = ["#722ed1", "#fa8c16", "#13c2c2", "#1677ff", "#eb2f96", "#52c41a", "#2f54eb", "#fa541c"];
  const colorOf = (text) => COLORS[[...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
  function badge(text, key) {
    const b = document.createElement("span");
    b.className = "sp-badge"; b.textContent = text; b.style.background = colorOf(key);
    return b;
  }
  function tile({ mark, title, sub, url, live }) {
    const el = document.createElement("button");
    el.type = "button"; el.className = "sp-tile"; el.title = url;
    el.appendChild(mark);
    const b = document.createElement("b"); b.textContent = title; el.appendChild(b);
    const small = document.createElement("small"); small.textContent = sub;
    if (live) small.className = "sp-live";
    el.appendChild(small);
    el.onclick = () => go(url);
    return el;
  }
  function fill(id, tiles) {
    const section = $(id), box = section.querySelector(".sp-tiles");
    box.textContent = "";
    for (const t of tiles) box.appendChild(t);
    section.style.display = tiles.length ? "block" : "none";
  }
  async function loadStart() {
    startLoadedAt = Date.now();
    let data = { servers: [], recent: [] };
    try { data = await (await fetch(basePath() + "api/start")).json(); } catch {}
    fill("sp-servers", (data.servers || []).map((s) => tile({ mark: badge(String(s.port), s.port), title: "localhost:" + s.port, sub: s.label, url: s.url, live: true })));
    fill("sp-recent", (data.recent || []).map((r) => {
      let host = r.url; try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch {}
      const letter = badge(host.slice(0, 1).toUpperCase(), host);
      const icon = document.createElement("img");
      icon.alt = ""; icon.src = iconUrl(new URL(r.url).origin + "/favicon.ico");
      icon.onerror = () => icon.replaceWith(letter);
      return tile({ mark: icon, title: r.title || host, sub: host, url: r.url });
    }));
  }
  function go(text) {
    if (!human()) { notDriving(); return; }
    send({ type: "navigate", url: text });
    focusKeys();
  }
  $("sp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("sp-q").value.trim();
    if (q) { $("sp-q").value = ""; go(q); }
  });
  $("sp-agent").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("sp-agent").querySelector("input"), text = input.value.trim();
    if (!text) return;
    input.value = "";
    window.parent.postMessage({ type: "cocalc-browser-agent", text }, "*");
    flash("Asking an agent...");
  });

  connect();
})();
</script>
</body>
</html>`;
