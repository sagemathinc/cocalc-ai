// The viewer page served by the shared browser and embedded in the chat card.
// Plain HTML and JS: no build step, no dependencies.
export const VIEWER_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared browser</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f1f1f; --muted:#666; --bar:#f3f3f3; --line:#d9d9d9; --accent:#1677ff; --warn:#fff4d6; --warnfg:#5c3d00; --tab:#e8e8e8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#e6e6e6; --muted:#9a9a9a; --bar:#1f1f1f; --line:#333; --accent:#4c8dff; --warn:#3a2f12; --warnfg:#ffd77a; --tab:#2a2a2a; } }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:13px system-ui, sans-serif; overflow:hidden; }
  #app { display:flex; flex-direction:column; height:100%; }
  #tabs { display:flex; gap:2px; padding:4px 6px 0; background:var(--bar); overflow-x:auto; }
  .tab { display:flex; align-items:center; gap:6px; max-width:200px; padding:4px 8px; border-radius:6px 6px 0 0; background:var(--tab); cursor:pointer; white-space:nowrap; }
  .tab.active { background:var(--bg); }
  .tab span { overflow:hidden; text-overflow:ellipsis; }
  .tab button, #newtab { border:none; background:none; color:var(--muted); cursor:pointer; padding:0 2px; font-size:13px; }
  #nav { display:flex; gap:4px; align-items:center; padding:4px 6px; background:var(--bg); border-bottom:1px solid var(--line); }
  #nav button { border:1px solid var(--line); background:var(--bar); color:var(--fg); border-radius:4px; padding:2px 8px; cursor:pointer; }
  #nav button.off { opacity:.45; }
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
  #stage { position:relative; flex:1; min-height:0; background:#888; }
  #screen { position:absolute; inset:0; width:100%; height:100%; outline:none; }
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
  </div>
  <div id="driver"><span class="msg"></span><button></button></div>
  <div id="stage">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="hint"></div>
    <div id="notdriving" class="overlay"><p></p><button>Take over</button></div>
    <div id="waiting" class="overlay"><p><b>Waiting for your computer.</b> This browser runs in Chrome on your computer, so sites see your network and your logins. Run this there (it needs the CoCalc CLI); a Chrome window opens, and stays connected while it runs:</p><pre></pre><div class="row"><button data-a="project">Run it in the project instead</button><button data-a="copy">Copy command</button></div></div>
    <div id="dialog" class="overlay"><pre></pre><input><div class="row"><button data-a="0">Cancel</button><button data-a="1">OK</button></div></div>
    <div id="select" class="overlay"></div>
    <div id="filechooser" class="overlay"><div style="margin-bottom:6px">Upload a project file (path relative to your home directory):</div><input placeholder="e.g. Documents/report.pdf"><div class="row"><button data-a="0">Cancel</button><button data-a="1">Upload</button></div></div>
    <div id="status">connecting...</div>
  </div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("screen"), ctx = canvas.getContext("2d"), stage = $("stage");
  let ws = null, state = null, retry = 0, lastPointer = { x: 20, y: 20 };
  // A browser on the user's computer: they use its window; this is a preview.
  const preview = () => state && state.runsOn === "computer";
  const human = () => state && state.driver === "human" && !preview();
  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function wsUrl() {
    let path = location.pathname.replace(/\/index\.html$/, "/");
    if (!path.endsWith("/")) path += "/";
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path + "viewer" + location.search;
  }
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
        try { const bmp = await createImageBitmap(ev.data); drawFrame(bmp); saveFrame(ev.data); } catch {}
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") { state = msg.state; render(); }
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
  function drawFrame(bmp) {
    // Redrawing the current frame (e.g. on resize) must not close it first.
    if (lastFrame && lastFrame !== bmp && lastFrame.close) lastFrame.close();
    lastFrame = bmp;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#888"; ctx.fillRect(0, 0, w, h);
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
  function quality() { try { return localStorage.getItem(QUALITY_KEY) || "sharp"; } catch { return "sharp"; } }
  $("quality").value = quality();
  $("quality").addEventListener("change", () => { try { localStorage.setItem(QUALITY_KEY, $("quality").value); } catch {} sendSize(true); canvas.focus(); });
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
      const label = document.createElement("span");
      label.textContent = tab.title || tab.url || "New tab"; el.title = tab.url;
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
    canvas.className = human() ? "" : "view-only";
    $("quality").style.display = preview() ? "none" : "";
    // Where a .browser file's browser runs, and waiting for the computer.
    const runson = $("runson");
    runson.style.display = state.runsOn ? "" : "none";
    if (state.runsOn && document.activeElement !== runson) runson.value = state.runsOn;
    const waiting = $("waiting");
    waiting.style.display = state.connection === "waiting" && state.runsOn === "computer" ? "block" : "none";
    waiting.querySelector("pre").textContent = state.connectCommand || "";
    if (state.connection === "waiting" && lastFrame) { ctx.fillStyle = "#888"; ctx.fillRect(0, 0, canvas.width, canvas.height); lastFrame = null; }
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
  }
  $("runson").addEventListener("change", () => send({ type: "runsOn", value: $("runson").value }));
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
  $("notdriving").querySelector("button").onclick = () => { $("notdriving").style.display = "none"; send({ type: "takeover" }); canvas.focus(); };
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
  const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
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
  canvas.addEventListener("mousedown", (e) => { canvas.focus(); if (state && state.select) send({ type: "select", index: -1 }); mouse("mousePressed", e, { button: BUTTONS[e.button] || "left", clickCount: e.detail || 1 }); e.preventDefault(); });
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
    if (!human()) { if (event === "keyDown") notDriving(); return; }
    // Let the system paste; it arrives as a paste event.
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    if (e.isComposing) return;
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
    // The browser's own key code is the Windows virtual key code CDP wants.
    // (A character's code is not: "(" is 40, which is ArrowDown.)
    const keyCode = e.keyCode || SPECIAL[e.key] || (/^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase().charCodeAt(0) : 0);
    send({ type: "key", event: event === "keyDown" ? (text ? "keyDown" : "rawKeyDown") : "keyUp", key: e.key, code: e.code, text: event === "keyDown" ? text : undefined, keyCode, modifiers: mods(e) });
  }
  canvas.addEventListener("keydown", (e) => key("keyDown", e));
  canvas.addEventListener("keyup", (e) => key("keyUp", e));
  canvas.addEventListener("compositionend", (e) => { if (human() && e.data) send({ type: "text", text: e.data }); });
  // One paste listener only: a paste on the canvas also bubbles to the document.
  document.addEventListener("paste", (e) => { if (document.activeElement !== canvas || !human()) return; e.preventDefault(); send({ type: "text", text: e.clipboardData.getData("text") }); });

  $("url").addEventListener("mousedown", () => { if (!human()) notDriving(); });
  $("url").addEventListener("keydown", (e) => { if (e.key === "Enter") { send({ type: "navigate", url: $("url").value }); canvas.focus(); } });
  const navButton = (id, msg) => { $(id).onclick = () => (human() ? send(msg) : notDriving()); };
  navButton("back", { type: "history", delta: -1 });
  navButton("fwd", { type: "history", delta: 1 });
  navButton("reload", { type: "reload" });

  connect();
})();
</script>
</body>
</html>`;
