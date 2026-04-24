#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2500;

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: node scripts/dev/codex-launchpad-one-turn-chromium.mjs --project <project-id> --prompt <text> [options]",
      "",
      "Options:",
      "  --base-url <url>           CoCalc hub URL (default: COCALC_API_URL)",
      "  --browser-base-url <url>   Browser-visible CoCalc URL for spawned Chromium target URLs",
      "  --project <id>             Project id containing the chat",
      "  --chat-path <path>         Chat file path (default: /home/user/a.chat)",
      "  --target-url <url>         Exact chat URL; overrides --chat-path URL construction",
      "  --prompt <text>            Prompt to send as exactly one browser chat turn",
      "  --prompt-file <path>       Read prompt from a file instead of --prompt",
      "  --smoke <name>             Built-in smoke/check: live-text, open-tabs, root-route",
      "  --smoke-path <path>        Project file path for smoke checks",
      "  --smoke-marker <text>      Marker text for smoke checks",
      "  --model <id>               Codex model for fallback frontend send (default: gpt-5.5)",
      "  --reasoning <level>        Codex reasoning for fallback frontend send (default: low)",
      "  --session-mode <mode>      Codex session mode for fallback send (default: full-access)",
      "  --browser <id>             Use an existing browser session instead of spawning Chromium",
      "  --spawn                    Spawn Chromium even when COCALC_BROWSER_ID is set",
      "  --out-dir <path>           Artifact directory (default: ./.cocalc-codex-one-turn/<ts>)",
      "  --timeout <ms>             Overall turn timeout (default: 600000)",
      "  --chromium <path>          Chromium path for spawned sessions",
      "  --fail-on-stale-build      Fail smoke checks when the page reports a stale frontend build",
      "  --headed                   Spawn a visible browser instead of headless",
      "  --keep-browser             Do not destroy the spawned browser session",
      "  --json                     Print only the final JSON summary",
      "  --help                     Show this help",
      "",
      "The script uses the CoCalc CLI browser-session machinery, so the spawned",
      "Chromium receives the same hub auth cookies as the active CLI profile.",
    ].join("\n"),
  );
  process.exit(code);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    usageAndExit(`${flag} requires a value`);
  }
  return value;
}

function envFlag(name) {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function normalizeChatPath(value) {
  const clean = `${value ?? ""}`.trim() || "/home/user/a.chat";
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function parseArgs(argv) {
  const options = {
    baseUrl:
      process.env.COCALC_CODEX_ONE_TURN_BASE_URL ??
      process.env.COCALC_API_URL ??
      "",
    browserBaseUrl: process.env.COCALC_CODEX_ONE_TURN_BROWSER_BASE_URL ?? "",
    projectId: process.env.COCALC_PROJECT_ID ?? "",
    chatPath:
      process.env.COCALC_CODEX_ONE_TURN_CHAT_PATH ?? "/home/user/a.chat",
    targetUrl: process.env.COCALC_CODEX_ONE_TURN_TARGET_URL ?? "",
    prompt: process.env.COCALC_CODEX_ONE_TURN_PROMPT ?? "",
    promptFile: "",
    smoke: process.env.COCALC_CODEX_ONE_TURN_SMOKE ?? "",
    smokePath:
      process.env.COCALC_CODEX_ONE_TURN_SMOKE_PATH ??
      "/home/user/codex-live-text-smoke.md",
    smokeMarker: process.env.COCALC_CODEX_ONE_TURN_SMOKE_MARKER ?? "",
    model: process.env.COCALC_CODEX_ONE_TURN_MODEL ?? "gpt-5.5",
    reasoning: process.env.COCALC_CODEX_ONE_TURN_REASONING ?? "low",
    sessionMode:
      process.env.COCALC_CODEX_ONE_TURN_SESSION_MODE ?? "full-access",
    browserId: process.env.COCALC_BROWSER_ID ?? "",
    forceSpawn: envFlag("COCALC_CODEX_ONE_TURN_SPAWN"),
    outDir: process.env.COCALC_CODEX_ONE_TURN_OUT_DIR ?? "",
    timeoutMs: Number(
      process.env.COCALC_CODEX_ONE_TURN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    ),
    chromiumPath:
      process.env.COCALC_CODEX_ONE_TURN_CHROMIUM ??
      process.env.COCALC_CHROMIUM_BIN ??
      "",
    failOnStaleBuild: envFlag("COCALC_CODEX_ONE_TURN_FAIL_ON_STALE_BUILD"),
    headed: envFlag("COCALC_CODEX_ONE_TURN_HEADED"),
    keepBrowser: envFlag("COCALC_CODEX_ONE_TURN_KEEP_BROWSER"),
    json: envFlag("COCALC_CODEX_ONE_TURN_JSON"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      usageAndExit("", 0);
    } else if (arg === "--base-url") {
      options.baseUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--browser-base-url") {
      options.browserBaseUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--project") {
      options.projectId = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--chat-path") {
      options.chatPath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--target-url") {
      options.targetUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--prompt") {
      options.prompt = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--prompt-file") {
      options.promptFile = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--smoke") {
      options.smoke = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--smoke-path") {
      options.smokePath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--smoke-marker") {
      options.smokeMarker = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--model") {
      options.model = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--reasoning") {
      options.reasoning = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--session-mode") {
      options.sessionMode = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--browser") {
      options.browserId = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--spawn") {
      options.forceSpawn = true;
    } else if (arg === "--out-dir") {
      options.outDir = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(takeValue(argv, i, arg));
      i += 1;
    } else if (arg === "--chromium") {
      options.chromiumPath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--fail-on-stale-build") {
      options.failOnStaleBuild = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--keep-browser") {
      options.keepBrowser = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      usageAndExit(`unknown argument: ${arg}`);
    }
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  options.browserBaseUrl = options.browserBaseUrl.trim().replace(/\/+$/, "");
  options.projectId = options.projectId.trim();
  options.chatPath = normalizeChatPath(options.chatPath);
  options.targetUrl = options.targetUrl.trim();
  options.smoke = options.smoke.trim();
  options.smokePath = normalizeChatPath(options.smokePath);
  options.smokeMarker =
    options.smokeMarker.trim() ||
    `cocalc-live-text-smoke-${new Date().toISOString()}`;
  options.model = options.model.trim() || "gpt-5.5";
  options.reasoning = options.reasoning.trim() || "low";
  options.sessionMode = options.sessionMode.trim() || "full-access";
  options.browserId = options.browserId.trim();
  if (options.forceSpawn && options.browserId) {
    options.browserId = "";
  }
  options.outDir =
    options.outDir.trim() ||
    path.join(
      SRC_ROOT,
      ".cocalc-codex-one-turn",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );

  if (!options.baseUrl) usageAndExit("--base-url is required");
  if (!options.projectId) usageAndExit("--project is required");
  if (
    options.smoke &&
    options.smoke !== "live-text" &&
    options.smoke !== "open-tabs" &&
    options.smoke !== "root-route"
  ) {
    usageAndExit(`unsupported --smoke value: ${options.smoke}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    usageAndExit("--timeout must be a positive number of milliseconds");
  }

  return options;
}

async function loadPrompt(options) {
  if (
    options.smoke === "root-route" &&
    !options.prompt &&
    !options.promptFile
  ) {
    return "";
  }
  if (options.smoke === "live-text" && !options.prompt && !options.promptFile) {
    return liveTextSmokePrompt(options);
  }
  if (options.smoke === "open-tabs" && !options.prompt && !options.promptFile) {
    return openTabsSmokePrompt(options);
  }
  if (options.promptFile) {
    return (await readFile(options.promptFile, "utf8")).trim();
  }
  return `${options.prompt ?? ""}`.trim();
}

function liveTextSmokePrompt(options) {
  return [
    "Run a CoCalc live text editor smoke test.",
    "",
    `Use the exact CoCalc CLI command from your runtime instructions. Do not use browser exec for the edit.`,
    `Use cocalc exec and api.text.open({ path: ${JSON.stringify(options.smokePath)}, projectIdentifier: process.env.COCALC_PROJECT_ID }).`,
    `Append this exact marker line to the file: ${JSON.stringify(options.smokeMarker)}`,
    "Use expectedHash or expectedLatestVersionId from a preceding read.",
    "Confirm the edit saved to disk by reading the file back with a project file command.",
    "In your final answer, include LIVE_TEXT_SMOKE_OK and the marker.",
  ].join("\n");
}

function openTabsSmokePrompt(options) {
  return [
    "Run a CoCalc open-tabs smoke test.",
    "",
    "Use the exact CoCalc CLI command from your runtime instructions.",
    'First command shape: <exact CoCalc CLI command> browser files --session-project-id "$COCALC_PROJECT_ID" --browser "$COCALC_BROWSER_ID"',
    "Use `browser files` or `browser tabs` for this. Do not use `browser exec` or `browser exec-api` unless the typed tab command fails.",
    "Report the open browser files/tabs with each path exactly as returned by the command.",
    "In your final answer, include OPEN_TABS_SMOKE_OK.",
    "In your final answer, include COMMAND_USED=browser files or COMMAND_USED=browser tabs.",
  ].join("\n");
}

function encodePathPreservingSlashes(value) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function chatUrl(options) {
  if (options.targetUrl) return options.targetUrl;
  const baseUrl = options.browserBaseUrl || options.baseUrl;
  return `${baseUrl}/projects/${encodeURIComponent(
    options.projectId,
  )}/files${encodePathPreservingSlashes(options.chatPath)}`;
}

function rootRouteUrl(options) {
  const baseUrl = options.browserBaseUrl || options.baseUrl;
  return `${baseUrl}/projects/${encodeURIComponent(options.projectId)}/files/`;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
}

function cliCommand() {
  const configured = `${process.env.COCALC_CLI_CMD ?? ""}`.trim();
  if (configured) return configured;
  const bin = `${process.env.COCALC_CLI_BIN ?? ""}`.trim();
  if (bin) return shellQuote(bin);

  const optNode = "/opt/cocalc/bin/node";
  const optCli = "/opt/cocalc/bin2/cocalc-cli.js";
  if (existsSync(optNode) && existsSync(optCli)) {
    return `${shellQuote(optNode)} ${shellQuote(optCli)}`;
  }
  return shellQuote(path.join(SRC_ROOT, "packages/cli/dist/bin/cocalc.js"));
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: SRC_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCocalcJson({ apiUrl, argv }, { timeoutMs = 120_000 } = {}) {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const cmd = [
    cliCommand(),
    "--api",
    shellQuote(apiUrl),
    "--json",
    "--timeout",
    shellQuote(`${timeoutSeconds}s`),
    "--rpc-timeout",
    shellQuote(`${timeoutSeconds}s`),
    ...argv.map(shellQuote),
  ].join(" ");
  const result = await spawnCapture("bash", ["-lc", cmd], {
    env: process.env,
  });
  if (result.code !== 0) {
    throw new Error(
      [
        `cocalc exited with code ${result.code}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `unable to parse cocalc JSON output: ${err}\n${result.stdout}`,
    );
  }
  if (!parsed?.ok) {
    throw new Error(JSON.stringify(parsed, null, 2));
  }
  return parsed;
}

async function browserExec({ options, browserId, code, timeoutMs }) {
  const scriptPath = path.join(options.outDir, `exec-${Date.now()}.js`);
  await writeFile(scriptPath, code);
  const response = await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "browser",
        "exec",
        "--browser",
        browserId,
        "--project-id",
        options.projectId,
        "--allow-raw-exec",
        "--file",
        scriptPath,
      ],
    },
    { timeoutMs },
  );
  return response.data?.result ?? response.data;
}

async function browserAction({ options, browserId, argv, timeoutMs }) {
  return await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "browser",
        "action",
        ...argv,
        "--browser",
        browserId,
        "--project-id",
        options.projectId,
        "--timeout",
        `${Math.ceil(timeoutMs / 1000)}s`,
      ],
    },
    { timeoutMs },
  );
}

async function browserOpenChat({ options, browserId, timeoutMs }) {
  return await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "browser",
        "open",
        "--browser",
        browserId,
        options.projectId,
        options.chatPath,
      ],
    },
    { timeoutMs },
  );
}

async function spawnBrowser(options, targetUrl) {
  const argv = [
    "browser",
    "session",
    "spawn",
    "--api-url",
    options.baseUrl,
    "--target-url",
    targetUrl,
    "--project-id",
    options.projectId,
    "--session-name",
    "CoCalc Codex one-turn harness",
    options.headed ? "--headed" : "--headless",
  ];
  if (options.chromiumPath) {
    argv.push("--chromium", options.chromiumPath);
  }
  return await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv,
    },
    { timeoutMs: Math.min(options.timeoutMs, 120_000) },
  );
}

async function destroyBrowser(options, id) {
  if (!id) return;
  await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: ["browser", "session", "destroy", id],
    },
    { timeoutMs: 30_000 },
  ).catch(() => undefined);
}

function chatReadyScript() {
  return `
return (() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const create = buttons.find((button) =>
    /create chat/i.test(button.textContent || "")
  );
  if (create) create.click();
  return {
    clickedCreateChat: Boolean(create),
    url: location.href,
    hasComposer: Boolean(document.querySelector('[data-testid="chat-composer"]')),
    bodyText: (document.body?.innerText || "").slice(0, 4000),
  };
})()
`;
}

function runtimeBootstrapScript() {
  return `
  function getRedux() {
    if (
      globalThis.cc?.redux &&
      typeof globalThis.cc.redux.currentEditor === "function"
    ) {
      return globalThis.cc.redux;
    }
    const chunk = globalThis.webpackChunk_cocalc_static;
    if (!Array.isArray(chunk)) return undefined;
    let webpackRequire = null;
    try {
      chunk.push([
        ["codex-one-turn-runtime-" + Date.now()],
        {},
        (req) => {
          webpackRequire = req;
        },
      ]);
    } catch {
      return undefined;
    }
    const modules = webpackRequire?.c ? Object.values(webpackRequire.c) : [];
    for (const mod of modules) {
      const exports = mod?.exports;
      if (exports == null) continue;
      const candidates = [exports];
      if (typeof exports === "object" || typeof exports === "function") {
        for (const key of Object.keys(exports)) candidates.push(exports[key]);
      }
      for (const candidate of candidates) {
        if (
          candidate != null &&
          typeof candidate === "object" &&
          typeof candidate.getStore === "function" &&
          typeof candidate.getActions === "function"
        ) {
          return candidate;
        }
      }
    }
    return undefined;
  }
`;
}

function projectRootRouteStateScript({ projectId }) {
  return `
return (() => {
  const projectId = ${JSON.stringify(projectId)};
  ${runtimeBootstrapScript()}

  function toPlain(value) {
    if (value == null) return value;
    if (typeof value.toJS === "function") return value.toJS();
    if (Array.isArray(value)) return value.map(toPlain);
    if (typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = toPlain(entry);
      return out;
    }
    return value;
  }

  function getProjectStore(redux) {
    if (!redux) return undefined;
    const candidates = [
      redux.getProjectStore?.(projectId),
      redux.getStore?.("project-" + projectId),
      redux.getStore?.("project:" + projectId),
      redux.getStore?.(projectId),
    ].filter(Boolean);
    if (candidates.length > 0) return candidates[0];
    const stores = redux._stores ?? redux.stores ?? redux.store;
    if (stores && typeof stores === "object") {
      for (const [name, store] of Object.entries(stores)) {
        if (String(name).includes(projectId)) return store;
      }
    }
    return undefined;
  }

  function read(store, key) {
    try {
      return toPlain(store?.get?.(key));
    } catch {
      return undefined;
    }
  }

  const redux = getRedux();
  const store = getProjectStore(redux);
  const bodyText = document.body?.innerText ?? "";
  const currentPath =
    read(store, "current_path_abs") ??
    read(store, "current_path") ??
    read(store, "directory") ??
    "";
  const historyPath =
    read(store, "history_path_abs") ??
    read(store, "history_path") ??
    "";
  const activeTab = read(store, "active_project_tab") ?? "";
  const pathFromUrl =
    decodeURIComponent(location.pathname)
      .replace(new RegExp("^/projects/" + projectId + "/files"), "") || "/";

  return {
    ok: Boolean(store),
    url: location.href,
    pathname: location.pathname,
    pathFromUrl,
    hasRedux: Boolean(redux),
    hasProjectStore: Boolean(store),
    currentPath: String(currentPath ?? ""),
    historyPath: String(historyPath ?? ""),
    activeTab: String(activeTab ?? ""),
    staleFrontendBuild: bodyText.includes("Stale Frontend Build Detected"),
    bodyTextTail: bodyText.slice(Math.max(0, bodyText.length - 3000)),
  };
})()
`;
}

function preparePromptInputScript() {
  return `
return (() => {
  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  const root =
    document.querySelector('[data-testid="chat-composer-input"]') ??
    document.body;
  const candidates = Array.from(
    root.querySelectorAll('[contenteditable="true"], textarea'),
  ).filter(isVisible);
  const target = candidates[candidates.length - 1];
  if (!target) {
    return {
      ok: false,
      error: "unable to find visible chat composer input",
      bodyText: (document.body?.innerText ?? "").slice(-4000),
    };
  }

  for (const element of document.querySelectorAll("[data-cocalc-one-turn-input]")) {
    element.removeAttribute("data-cocalc-one-turn-input");
  }
  target.setAttribute("data-cocalc-one-turn-input", "true");
  target.focus();
  return {
    ok: true,
    tagName: target.tagName,
    textBefore: target.textContent ?? target.value ?? "",
  };
})()
`;
}

function clickSendScript({ prompt, model, reasoning, sessionMode }) {
  return `
return new Promise((resolve) => {
  const prompt = ${JSON.stringify(prompt)};
  const model = ${JSON.stringify(model)};
  const reasoning = ${JSON.stringify(reasoning)};
  const sessionMode = ${JSON.stringify(sessionMode)};
  ${runtimeBootstrapScript()}

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  const started = Date.now();
  const clickWhenReady = () => {
    const buttons = Array.from(document.querySelectorAll("button")).filter(
      isVisible,
    );
    const send =
      document.querySelector('[data-testid="chat-composer-send"]') ??
      buttons.find((button) => /^(send|queue)$/i.test((button.textContent ?? "").trim()));
    if (!send) {
      if (Date.now() - started < 5000) {
        setTimeout(clickWhenReady, 100);
        return;
      }
      const editorActions = getRedux()?.currentEditor?.()?.actions;
      const actions =
        editorActions?.getChatActions?.() ??
        editorActions?.chatActions ??
        editorActions;
      if (typeof actions?.sendChat === "function") {
        const codexConfig = {
          model,
          reasoning,
          sessionMode,
          allowWrite: sessionMode !== "read-only",
        };
        const result = actions.sendChat({
          input: prompt,
          threadAgent: {
            mode: "codex",
            model,
            codexConfig,
          },
          acpConfigOverride: codexConfig,
        });
        resolve({
          ok: true,
          method: "actions.sendChat",
          result,
        });
        return;
      }
      resolve({
        ok: false,
        error: "unable to find visible Send button",
        buttons: buttons.map((button) => (button.textContent ?? "").trim()).slice(-20),
      });
      return;
    }
    send.click();
    resolve({
      ok: true,
      inputText: target.textContent ?? target.value ?? "",
      buttonText: send.textContent ?? "",
    });
  };
  clickWhenReady();
})
`;
}

function scrapeChatStateScript({ prompt, submittedAtMs }) {
  return `
return (() => {
  const prompt = ${JSON.stringify(prompt)};
  const submittedAtMs = ${JSON.stringify(submittedAtMs)};
  const activeStates = new Set(["queue", "sending", "sent", "running"]);
  ${runtimeBootstrapScript()}

  function toPlain(value) {
    if (value == null) return value;
    if (typeof value.toJS === "function") return value.toJS();
    if (Array.isArray(value)) return value.map(toPlain);
    if (value instanceof Map) {
      return Array.from(value.entries()).map(([key, entry]) => [
        key,
        toPlain(entry),
      ]);
    }
    if (typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = toPlain(entry);
      return out;
    }
    return value;
  }

  function messageContent(message) {
    const history = Array.isArray(message?.history) ? message.history : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const content = history[i]?.content;
      if (typeof content === "string" && content.trim()) return content;
    }
    for (const key of ["value", "input", "content"]) {
      const content = message?.[key];
      if (typeof content === "string" && content.trim()) return content;
    }
    return "";
  }

  function messageMs(key, message) {
    const parsedKey = Number(key);
    if (Number.isFinite(parsedKey)) return parsedKey;
    const parsedDate = Date.parse(message?.date ?? "");
    return Number.isFinite(parsedDate) ? parsedDate : 0;
  }

  const redux = getRedux();
  const editorActions = redux?.currentEditor?.()?.actions;
  const actions =
    editorActions?.getChatActions?.() ??
    editorActions?.chatActions ??
    editorActions;
  const accountStore = redux?.getStore?.("account");
  const accountId =
    accountStore?.get_account_id?.() ?? accountStore?.get?.("account_id") ?? "";
  const store = actions?.redux?.getStore?.(actions?.name);
  const acpStateRaw = store?.get?.("acpState") ?? store?.get?.("acp_state");
  const acpStateEntries = Array.from(
    typeof acpStateRaw?.entries === "function"
      ? acpStateRaw.entries()
      : Object.entries(toPlain(acpStateRaw) ?? {}),
  ).map(([key, value]) => [String(key), String(value)]);
  const messages = Array.from(actions?.getAllMessages?.() ?? [])
    .map(([key, message]) => {
      const plain = toPlain(message) ?? {};
      return {
        key: String(key),
        ms: messageMs(key, plain),
        sender_id: String(plain.sender_id ?? ""),
        thread_id: String(plain.thread_id ?? ""),
        message_id: String(plain.message_id ?? ""),
        acp_account_id: String(plain.acp_account_id ?? ""),
        generating: plain.generating === true,
        content: messageContent(plain),
      };
    })
    .sort((a, b) => a.ms - b.ms);

  const matchingUser = [...messages].reverse().find(
    (message) =>
      message.ms >= submittedAtMs - 10000 &&
      message.sender_id === accountId &&
      message.content.trim() === prompt.trim(),
  );
  const fallbackUser = [...messages].reverse().find(
    (message) =>
      message.ms >= submittedAtMs - 10000 && message.sender_id === accountId,
  );
  const userMessage = matchingUser ?? fallbackUser;
  const threadId = userMessage?.thread_id ?? "";
  const relevantMessages = threadId
    ? messages.filter((message) => message.thread_id === threadId)
    : messages.filter((message) => message.ms >= submittedAtMs - 10000);
  const activeAcpStates = acpStateEntries.filter(([key, value]) => {
    if (!activeStates.has(value)) return false;
    if (!threadId) return true;
    if (key === "thread:" + threadId) return true;
    return relevantMessages.some(
      (message) => key === message.key || key === "message:" + message.message_id,
    );
  });
  const generatingMessages = relevantMessages.filter(
    (message) => message.generating && message.acp_account_id,
  );
  const assistantMessages = relevantMessages.filter(
    (message) =>
      message.sender_id &&
      message.sender_id !== accountId &&
      message.sender_id !== "__thread_config__" &&
      message.content.trim(),
  );
  const finalMessage = assistantMessages[assistantMessages.length - 1] ?? null;
  const active = activeAcpStates.length > 0 || generatingMessages.length > 0;
  const bodyText = document.body?.innerText ?? "";

  return {
    ok: Boolean(actions),
    url: location.href,
    actionsName: actions?.name ?? "",
    actionsState: actions?._state ?? "",
    syncdbState: actions?.syncdb?.get_state?.() ?? "",
    accountId,
    threadId,
    active,
    activeAcpStates,
    generatingMessages,
    userMessage,
    finalMessage,
    finalAnswer: finalMessage?.content ?? "",
    messages: messages.slice(-20),
    bodyTextTail: bodyText.slice(Math.max(0, bodyText.length - 8000)),
  };
})()
`;
}

async function waitForFinalAnswer({
  options,
  browserId,
  prompt,
  submittedAtMs,
}) {
  const started = Date.now();
  let lastState = undefined;
  while (Date.now() - started < options.timeoutMs) {
    const result = await browserExec({
      options,
      browserId,
      code: scrapeChatStateScript({ prompt, submittedAtMs }),
      timeoutMs: 45_000,
    });
    lastState = result;
    await writeFile(
      path.join(options.outDir, "latest-chat-state.json"),
      JSON.stringify(lastState, null, 2),
    );
    if (lastState?.finalAnswer && !lastState?.active) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `timed out waiting for final Codex answer; last state:\n${JSON.stringify(
      lastState,
      null,
      2,
    )}`,
  );
}

async function captureScreenshot({ options, browserId, label }) {
  const result = await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "browser",
        "screenshot",
        "--browser",
        browserId,
        "--project-id",
        options.projectId,
        "--out",
        path.join(options.outDir, `${label}.png`),
      ],
    },
    { timeoutMs: 60_000 },
  ).catch((err) => ({ ok: false, error: `${err}` }));
  await writeFile(
    path.join(options.outDir, `${label}-screenshot.json`),
    JSON.stringify(result, null, 2),
  );
  return result;
}

function extractProjectFileCatText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value !== "object") return `${value}`;
  for (const key of ["content", "text", "stdout", "data"]) {
    const text = extractProjectFileCatText(value[key]);
    if (text) return text;
  }
  return "";
}

async function verifyOpenTabsSmoke({ options, browserId, finalState }) {
  const files = await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "browser",
        "files",
        "--browser",
        browserId,
        "--session-project-id",
        options.projectId,
      ],
    },
    { timeoutMs: 120_000 },
  );
  const rows = Array.isArray(files.data) ? files.data : [];
  const paths = rows
    .filter((row) => `${row?.project_id ?? ""}` === options.projectId)
    .map((row) => `${row?.path ?? ""}`.trim())
    .filter((path) => path.length > 0);
  const finalAnswer = `${finalState?.finalAnswer ?? ""}`;
  const missingPaths = paths.filter((path) => !finalAnswer.includes(path));
  const commandMatch = /COMMAND_USED=browser (files|tabs)/.test(finalAnswer);
  const ok =
    finalAnswer.includes("OPEN_TABS_SMOKE_OK") &&
    commandMatch &&
    missingPaths.length === 0;
  const result = {
    ok,
    name: options.smoke,
    browser_id: browserId,
    files,
    expected_paths: paths,
    missing_paths: missingPaths,
    command_match: commandMatch,
    final_answer: finalAnswer,
  };
  await writeFile(
    path.join(options.outDir, "smoke-verification.json"),
    JSON.stringify(result, null, 2),
  );
  if (!ok) {
    throw new Error(
      `open-tabs smoke failed: ${JSON.stringify(
        {
          marker: finalAnswer.includes("OPEN_TABS_SMOKE_OK"),
          command_match: commandMatch,
          missing_paths: missingPaths,
        },
        null,
        2,
      )}`,
    );
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rootRouteStateIsSafe(state) {
  if (!state?.hasProjectStore) return false;
  const paths = [state.currentPath, state.historyPath]
    .map((value) => `${value ?? ""}`.trim())
    .filter(Boolean);
  if (paths.some((value) => value === "/")) return false;
  return paths.some(
    (value) => value === "/home/user" || value.startsWith("/home/user/"),
  );
}

async function verifyRootRouteSmoke({ options, browserId }) {
  const started = Date.now();
  const timeoutMs = Math.min(options.timeoutMs, 90_000);
  let lastState;
  while (Date.now() - started < timeoutMs) {
    lastState = await browserExec({
      options,
      browserId,
      code: projectRootRouteStateScript({ projectId: options.projectId }),
      timeoutMs: 45_000,
    });
    await writeFile(
      path.join(options.outDir, "latest-root-route-state.json"),
      JSON.stringify(lastState, null, 2),
    );
    const safe = rootRouteStateIsSafe(lastState);
    if (safe && options.failOnStaleBuild && lastState?.staleFrontendBuild) {
      break;
    }
    if (safe) {
      const result = {
        ok: true,
        name: options.smoke,
        browser_id: browserId,
        stale_frontend_build: Boolean(lastState.staleFrontendBuild),
        state: lastState,
      };
      await writeFile(
        path.join(options.outDir, "smoke-verification.json"),
        JSON.stringify(result, null, 2),
      );
      return result;
    }
    await sleep(1000);
  }

  const result = {
    ok: false,
    name: options.smoke,
    browser_id: browserId,
    state: lastState,
    reason:
      options.failOnStaleBuild && lastState?.staleFrontendBuild
        ? "page reports a stale frontend build"
        : "project /files/ route did not resolve to /home/user",
  };
  await writeFile(
    path.join(options.outDir, "smoke-verification.json"),
    JSON.stringify(result, null, 2),
  );
  throw new Error(
    `root-route smoke failed:\n${JSON.stringify(result, null, 2)}`,
  );
}

async function verifySmoke({ options, browserId, finalState }) {
  if (options.smoke === "open-tabs") {
    return await verifyOpenTabsSmoke({ options, browserId, finalState });
  }
  if (options.smoke !== "live-text") return undefined;
  const cat = await runCocalcJson(
    {
      apiUrl: options.baseUrl,
      argv: [
        "project",
        "file",
        "cat",
        options.smokePath,
        "-w",
        options.projectId,
      ],
    },
    { timeoutMs: 120_000 },
  );
  const content = extractProjectFileCatText(cat.data);
  const ok =
    content.includes(options.smokeMarker) ||
    JSON.stringify(cat).includes(options.smokeMarker);
  const result = {
    ok,
    name: options.smoke,
    path: options.smokePath,
    marker: options.smokeMarker,
    project_file_cat: cat,
  };
  await writeFile(
    path.join(options.outDir, "smoke-verification.json"),
    JSON.stringify(result, null, 2),
  );
  if (!ok) {
    throw new Error(
      `live-text smoke marker was not found in ${options.smokePath}`,
    );
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await loadPrompt(options);
  if (!prompt && options.smoke !== "root-route") {
    usageAndExit("--prompt or --prompt-file is required");
  }
  await mkdir(options.outDir, { recursive: true });

  const targetUrl =
    options.smoke === "root-route" ? rootRouteUrl(options) : chatUrl(options);
  let spawnId = "";
  let browserId = options.browserId;
  const artifacts = {
    out_dir: options.outDir,
    target_url: targetUrl,
    run_json: path.join(options.outDir, "run.json"),
    latest_chat_state_json: path.join(options.outDir, "latest-chat-state.json"),
    latest_root_route_state_json: path.join(
      options.outDir,
      "latest-root-route-state.json",
    ),
  };

  if (!browserId) {
    if (!options.json) console.error(`spawning Chromium at ${targetUrl}`);
    const spawned = await spawnBrowser(options, targetUrl);
    await writeFile(
      path.join(options.outDir, "spawn.json"),
      JSON.stringify(spawned, null, 2),
    );
    spawnId = `${spawned.data?.spawn_id ?? ""}`.trim();
    browserId = `${spawned.data?.browser_id ?? ""}`.trim();
    if (!browserId) {
      throw new Error(
        `spawn did not return browser_id:\n${JSON.stringify(spawned, null, 2)}`,
      );
    }
  } else {
    if (!options.json) console.error(`using browser ${browserId}`);
    await browserAction({
      options,
      browserId,
      argv: ["navigate", targetUrl],
      timeoutMs: 60_000,
    });
  }

  let summary;
  try {
    await browserAction({
      options,
      browserId,
      argv: ["wait-for-selector", "body"],
      timeoutMs: 60_000,
    });
    if (options.smoke === "root-route") {
      const smoke = await verifyRootRouteSmoke({ options, browserId });
      await captureScreenshot({ options, browserId, label: "final" });
      summary = {
        ok: true,
        base_url: options.baseUrl,
        browser_base_url: options.browserBaseUrl || undefined,
        project_id: options.projectId,
        browser_id: browserId,
        spawn_id: spawnId || undefined,
        smoke,
        artifacts,
      };
      await writeFile(artifacts.run_json, JSON.stringify(summary, null, 2));
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    await browserExec({
      options,
      browserId,
      code: chatReadyScript(),
      timeoutMs: 45_000,
    });
    const composerSelector =
      '[data-testid="chat-composer"], [contenteditable="true"], textarea';
    try {
      await browserAction({
        options,
        browserId,
        argv: ["wait-for-selector", composerSelector],
        timeoutMs: 45_000,
      });
    } catch (err) {
      await browserOpenChat({ options, browserId, timeoutMs: 60_000 });
      await browserExec({
        options,
        browserId,
        code: chatReadyScript(),
        timeoutMs: 45_000,
      });
      await browserAction({
        options,
        browserId,
        argv: ["wait-for-selector", composerSelector],
        timeoutMs: 90_000,
      }).catch((retryErr) => {
        retryErr.cause = err;
        throw retryErr;
      });
    }
    const inputResult = await browserExec({
      options,
      browserId,
      code: preparePromptInputScript(),
      timeoutMs: 60_000,
    });
    if (!inputResult?.ok) {
      throw new Error(
        `unable to find prompt input:\n${JSON.stringify(inputResult, null, 2)}`,
      );
    }
    await browserAction({
      options,
      browserId,
      argv: ["type", '[data-cocalc-one-turn-input="true"]', prompt, "--clear"],
      timeoutMs: 60_000,
    });
    const submittedAtMs = Date.now();
    const submitResult = await browserExec({
      options,
      browserId,
      code: clickSendScript({
        prompt,
        model: options.model,
        reasoning: options.reasoning,
        sessionMode: options.sessionMode,
      }),
      timeoutMs: 60_000,
    });
    if (!submitResult?.ok) {
      throw new Error(
        `unable to submit prompt:\n${JSON.stringify(submitResult, null, 2)}`,
      );
    }
    const finalState = await waitForFinalAnswer({
      options,
      browserId,
      prompt,
      submittedAtMs,
    });
    const smoke = await verifySmoke({ options, browserId, finalState });
    await captureScreenshot({ options, browserId, label: "final" });
    summary = {
      ok: true,
      base_url: options.baseUrl,
      browser_base_url: options.browserBaseUrl || undefined,
      project_id: options.projectId,
      chat_path: options.chatPath,
      model: options.model,
      reasoning: options.reasoning,
      session_mode: options.sessionMode,
      browser_id: browserId,
      spawn_id: spawnId || undefined,
      smoke,
      prompt,
      final_answer: finalState.finalAnswer,
      final_state: finalState,
      artifacts,
    };
    await writeFile(artifacts.run_json, JSON.stringify(summary, null, 2));
  } catch (err) {
    await captureScreenshot({ options, browserId, label: "failure" });
    summary = {
      ok: false,
      base_url: options.baseUrl,
      browser_base_url: options.browserBaseUrl || undefined,
      project_id: options.projectId,
      chat_path: options.chatPath,
      model: options.model,
      reasoning: options.reasoning,
      session_mode: options.sessionMode,
      browser_id: browserId,
      spawn_id: spawnId || undefined,
      prompt,
      error: err?.stack ?? `${err}`,
      artifacts,
    };
    await writeFile(artifacts.run_json, JSON.stringify(summary, null, 2));
    throw err;
  } finally {
    if (spawnId && !options.keepBrowser) {
      await destroyBrowser(options, spawnId);
    }
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err?.stack ?? `${err}`);
  process.exit(1);
});
