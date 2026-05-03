#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONTEXT_FILE = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "current-context.json",
);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: attach.js --mode <lite|hub> [--browser <auto|live|spawned>] [--project-id <uuid>] [--target-url <url>] [--session-name <name>] [--headed] [--json] [--shell] [--no-use] [--context-file <path>]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    mode: "",
    browser: "auto",
    json: false,
    shell: false,
    use: true,
    headed: false,
    contextFile: DEFAULT_CONTEXT_FILE,
    projectId: "",
    targetUrl: "",
    sessionName: "",
    readyTimeout: "20s",
    timeout: "45s",
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--mode") {
      options.mode = `${normalizedArgv[++i] || ""}`.trim().toLowerCase();
    } else if (arg === "--browser") {
      options.browser = `${normalizedArgv[++i] || ""}`.trim().toLowerCase();
    } else if (arg === "--project-id") {
      options.projectId = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--target-url") {
      options.targetUrl = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--session-name") {
      options.sessionName = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--ready-timeout") {
      options.readyTimeout =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--ready-timeout requires a value");
    } else if (arg === "--timeout") {
      options.timeout =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--timeout requires a value");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--shell") {
      options.shell = true;
    } else if (arg === "--no-use") {
      options.use = false;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  if (!["lite", "hub"].includes(options.mode)) {
    usageAndExit("--mode must be lite or hub");
  }
  if (!["auto", "live", "spawned"].includes(options.browser)) {
    usageAndExit("--browser must be auto, live, or spawned");
  }
  if (options.json && options.shell) {
    usageAndExit("--json and --shell cannot be used together");
  }
  return options;
}

function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to parse ${label} JSON: ${detail}`);
  }
}

function unwrapCliJsonPayload(parsed) {
  if (
    parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "ok") &&
    Object.prototype.hasOwnProperty.call(parsed, "data")
  ) {
    return parsed.data;
  }
  return parsed;
}

function run(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function normalizeBoolean(value) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isCliAgentMode() {
  return (
    normalizeBoolean(process.env.COCALC_CLI_AGENT_MODE) ||
    normalizeBoolean(process.env.COCALC_AGENT_MODE)
  );
}

function getDevEnv(mode) {
  const result = run(process.execPath, [
    path.join(ROOT, "scripts", "dev", "dev-env.js"),
    mode,
    "--json",
    "--with-browser",
  ]);
  if (result.status !== 0) {
    throw new Error(
      `dev-env failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return parseJsonOutput(result.stdout, "dev-env");
}

function createCliEnv(devEnv) {
  const env = { ...process.env, ...devEnv.exports };
  if (devEnv.path_prepend) {
    env.PATH = `${devEnv.path_prepend}:${process.env.PATH ?? ""}`;
  }
  return env;
}

function runCliJson(devEnv, args) {
  const cliBin = `${devEnv.cli_bin ?? ""}`.trim();
  if (!cliBin) {
    throw new Error(
      "dev-env did not provide COCALC_CLI_BIN; build @cocalc/cli first",
    );
  }
  const result = run(process.execPath, [cliBin, "--json", ...args], {
    env: createCliEnv(devEnv),
  });
  if (result.status !== 0) {
    throw new Error(
      `cocalc ${args.join(" ")} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return unwrapCliJsonPayload(
    parseJsonOutput(result.stdout, `cocalc ${args.join(" ")}`),
  );
}

function preferredBrowserIdFromDevEnv(devEnv) {
  return (
    `${devEnv?.browser_id ?? ""}`.trim() ||
    `${devEnv?.exports?.COCALC_BROWSER_ID ?? ""}`.trim()
  );
}

function isAgentAuthSessionListUnavailable(err) {
  const message =
    `${err instanceof Error ? err.message : (err ?? "")}`.toLowerCase();
  return (
    message.includes("browser session list is unavailable under agent auth") ||
    (message.includes("browser session list") &&
      message.includes("known browser id via cocalc_browser_id"))
  );
}

function selectLiveSession(
  sessions,
  preferredBrowserId,
  projectId,
  excludedBrowserIds = [],
) {
  const excluded = new Set(excludedBrowserIds.filter(Boolean));
  const activeSessions = (Array.isArray(sessions) ? sessions : []).filter(
    (session) => !excluded.has(`${session?.browser_id ?? ""}`.trim()),
  );
  if (preferredBrowserId) {
    const preferred = activeSessions.find(
      (session) => session.browser_id === preferredBrowserId,
    );
    if (preferred) return preferred;
  }
  if (projectId) {
    const matchingProject = activeSessions.find(
      (session) => session.active_project_id === projectId,
    );
    if (matchingProject) return matchingProject;
  }
  return activeSessions[0];
}

function listActiveSessions(devEnv, projectId) {
  const args = ["browser", "session", "list", "--active-only"];
  if (projectId) {
    args.push("--project-id", projectId);
  }
  return runCliJson(devEnv, args);
}

function buildDirectLiveSession(devEnv, options) {
  const browserId = preferredBrowserIdFromDevEnv(devEnv);
  if (!browserId) return undefined;
  const projectId = options.projectId || devEnv.project_id || "";
  return {
    browser_mode: "live",
    browser_id: browserId,
    session_url: options.targetUrl ?? "",
    active_project_id: projectId,
    session_name: "",
  };
}

function extractSpawnSessionMarker(spawned) {
  for (const rawValue of [spawned?.target_url, spawned?.session_url]) {
    const value = `${rawValue ?? ""}`.trim();
    if (!value) continue;
    try {
      const marker = new URL(value).searchParams.get("_cocalc_browser_spawn");
      if (marker) return marker;
    } catch {}
    const match = value.match(/[?&]_cocalc_browser_spawn=([^&#]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return "";
}

function pickMostRecentSession(sessions) {
  const rows = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  return rows
    .slice()
    .sort((left, right) =>
      `${right?.updated_at ?? right?.created_at ?? ""}`.localeCompare(
        `${left?.updated_at ?? left?.created_at ?? ""}`,
      ),
    )[0];
}

function resolveSpawnedLiveSession(
  sessions,
  spawned,
  projectId,
  previousBrowserIds = [],
) {
  const rows = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (!rows.length) return undefined;
  const previous = new Set(previousBrowserIds.filter(Boolean));
  const freshRows = rows.filter(
    (session) => !previous.has(`${session?.browser_id ?? ""}`.trim()),
  );
  const preferredRows = freshRows.length ? freshRows : rows;
  const spawnMarker = extractSpawnSessionMarker(spawned);
  if (spawnMarker) {
    const byMarker = preferredRows.find((session) =>
      `${session?.url ?? ""}`.includes(spawnMarker),
    );
    if (byMarker) return byMarker;
  }
  const sessionName = `${spawned?.session_name ?? ""}`.trim();
  if (sessionName) {
    const byName = preferredRows.find(
      (session) => `${session?.session_name ?? ""}`.trim() === sessionName,
    );
    if (byName) return byName;
  }
  if (projectId) {
    const matchingProject = pickMostRecentSession(
      preferredRows.filter(
        (session) => session.active_project_id === projectId,
      ),
    );
    if (matchingProject) return matchingProject;
  }
  return pickMostRecentSession(preferredRows);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupSpawnedSessions(devEnv, browserMode) {
  const reap = runCliJson(devEnv, [
    "browser",
    "session",
    "reap",
    "--timeout",
    "2s",
  ]);
  const spawned = runCliJson(devEnv, ["browser", "session", "spawned"]);
  const rows = Array.isArray(spawned) ? spawned : [];
  const destroyed = [];
  for (const row of rows) {
    if (!shouldDestroySpawnedRow(row, browserMode)) continue;
    const destroyResult = runCliJson(devEnv, [
      "browser",
      "session",
      "destroy",
      `${row.spawn_id ?? row.browser_id ?? ""}`,
      "--timeout",
      "3s",
    ]);
    destroyed.push(destroyResult);
  }
  const remaining = runCliJson(devEnv, ["browser", "session", "spawned"]);
  return {
    reap,
    destroyed,
    remaining: Array.isArray(remaining) ? remaining : [],
  };
}

function mergeCleanupResults(left, right) {
  return {
    reap: right?.reap ?? left?.reap,
    destroyed: [...(left?.destroyed ?? []), ...(right?.destroyed ?? [])],
    remaining: right?.remaining ?? left?.remaining ?? [],
  };
}

function shouldDestroySpawnedRow(row, browserMode) {
  return (
    !!row?.running &&
    (browserMode === "spawned" || !`${row?.browser_id ?? ""}`.trim())
  );
}

function attachToLiveSession(
  devEnv,
  options,
  excludedBrowserIds = [],
  listSessionsFn = listActiveSessions,
) {
  const projectId = options.projectId || devEnv.project_id || "";
  let sessions;
  try {
    sessions = listSessionsFn(devEnv, projectId);
  } catch (err) {
    if (!isAgentAuthSessionListUnavailable(err)) {
      throw err;
    }
    return buildDirectLiveSession(devEnv, options);
  }
  const selected = selectLiveSession(
    sessions,
    preferredBrowserIdFromDevEnv(devEnv),
    projectId,
    excludedBrowserIds,
  );
  if (!selected) return undefined;
  if (options.use) {
    runCliJson(devEnv, ["browser", "session", "use", `${selected.browser_id}`]);
  }
  return {
    browser_mode: "live",
    browser_id: selected.browser_id,
    session_url: selected.url ?? "",
    active_project_id: selected.active_project_id ?? projectId,
    session_name: selected.session_name ?? "",
  };
}

function attachToSpawnedSession(devEnv, options) {
  const projectId = options.projectId || devEnv.project_id || "";
  const existingSessions = listActiveSessions(devEnv, projectId);
  const args = [
    "browser",
    "session",
    "spawn",
    "--api-url",
    devEnv.api_url,
    "--ready-timeout",
    options.readyTimeout,
    "--timeout",
    options.timeout,
  ];
  if (projectId) {
    args.push("--project-id", projectId);
  }
  if (options.targetUrl) {
    args.push("--target-url", options.targetUrl);
  }
  if (options.sessionName) {
    args.push("--session-name", options.sessionName);
  }
  if (options.headed) {
    args.push("--headed");
  }
  if (options.use) {
    args.push("--use");
  }
  const spawned = runCliJson(devEnv, args);
  let resolved = resolveSpawnedLiveSession(
    listActiveSessions(devEnv, projectId),
    spawned,
    projectId,
    existingSessions.map((session) => `${session?.browser_id ?? ""}`.trim()),
  );
  for (let attempt = 0; !resolved && attempt < 20; attempt += 1) {
    sleepMs(500);
    resolved = resolveSpawnedLiveSession(
      listActiveSessions(devEnv, projectId),
      spawned,
      projectId,
      existingSessions.map((session) => `${session?.browser_id ?? ""}`.trim()),
    );
  }
  if (!resolved) {
    throw new Error(
      `spawned browser session '${spawned.spawn_id ?? spawned.browser_id ?? "unknown"}' did not surface an active live browser session`,
    );
  }
  if (options.use && resolved.browser_id !== spawned.browser_id) {
    runCliJson(devEnv, ["browser", "session", "use", `${resolved.browser_id}`]);
  }
  return {
    browser_mode: "spawned",
    browser_id: resolved.browser_id,
    spawn_id: spawned.spawn_id,
    session_url:
      resolved.url ??
      spawned.session_url ??
      spawned.url ??
      spawned.target_url ??
      "",
    active_project_id:
      resolved.active_project_id ?? spawned.project_id ?? projectId,
    session_name:
      resolved.session_name ??
      spawned.session_name ??
      options.sessionName ??
      "",
    target_url: spawned.target_url ?? options.targetUrl ?? "",
  };
}

function buildUnattachedSession(devEnv, options, warning) {
  return {
    browser_mode: "unattached",
    browser_id: "",
    active_project_id: options.projectId || devEnv.project_id || "",
    session_url: "",
    session_name: "",
    target_url: options.targetUrl ?? "",
    warning,
  };
}

function shouldUseUnattachedAutoFallback(devEnv, options, attached) {
  if (attached || options.browser !== "auto") return false;
  if (options.mode === "hub") return true;
  return isCliAgentMode() && !preferredBrowserIdFromDevEnv(devEnv);
}

function buildContext(devEnv, options, cleanup, attached) {
  return {
    mode: options.mode,
    browser_mode: attached.browser_mode,
    api_url: devEnv.api_url,
    account_id: devEnv.exports?.COCALC_ACCOUNT_ID ?? "",
    project_id:
      attached.active_project_id || options.projectId || devEnv.project_id,
    browser_id: attached.browser_id,
    session_url: attached.session_url ?? "",
    session_name: attached.session_name ?? "",
    spawn_id: attached.spawn_id,
    target_url: attached.target_url ?? options.targetUrl ?? "",
    warning: attached.warning ?? "",
    cli_bin: devEnv.cli_bin,
    cleanup: {
      reaped_rows: cleanup.reap?.rows?.length ?? cleanup.reap?.scanned ?? 0,
      destroyed_running_spawned: cleanup.destroyed.length,
      remaining_spawned: cleanup.remaining.length,
    },
    exports: {
      ...devEnv.exports,
      COCALC_BROWSER_ID: attached.browser_id,
      COCALC_PROJECT_ID:
        attached.active_project_id || options.projectId || devEnv.project_id,
    },
  };
}

function writeContextFile(contextFile, payload) {
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  fs.writeFileSync(contextFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function emitShell(exportsMap) {
  for (const [key, value] of Object.entries(exportsMap)) {
    const escaped = `${value ?? ""}`.replace(/'/g, "'\"'\"'");
    console.log(`export ${key}='${escaped}'`);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const devEnv = getDevEnv(options.mode);
  let cleanup = cleanupSpawnedSessions(
    devEnv,
    options.browser === "spawned" ? "spawned" : "live",
  );
  let attached;
  if (options.browser === "spawned") {
    attached = attachToSpawnedSession(devEnv, options);
  } else if (options.browser === "live") {
    attached = attachToLiveSession(devEnv, options);
    if (!attached) {
      throw new Error(
        "no active live browser session matched the requested context",
      );
    }
  } else {
    const spawnedBrowserIds = cleanup.remaining.map((row) => row.browser_id);
    attached = attachToLiveSession(devEnv, options, spawnedBrowserIds);
    if (!attached) {
      if (shouldUseUnattachedAutoFallback(devEnv, options, attached)) {
        attached = buildUnattachedSession(
          devEnv,
          options,
          options.mode === "hub"
            ? "no active live browser session found; skipped spawned fallback for hub auto mode"
            : "no known live browser id available under agent auth; skipped spawned fallback",
        );
      } else {
        cleanup = mergeCleanupResults(
          cleanup,
          cleanupSpawnedSessions(devEnv, "spawned"),
        );
        attached = attachToSpawnedSession(devEnv, options);
      }
    }
  }
  const payload = buildContext(devEnv, options, cleanup, attached);
  writeContextFile(options.contextFile, payload);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (options.shell) {
    emitShell(payload.exports);
    return;
  }
  console.log(`bug-hunt attach (${payload.mode}/${payload.browser_mode})`);
  console.log(`api:        ${payload.api_url}`);
  console.log(`browser id: ${payload.browser_id}`);
  console.log(`project id: ${payload.project_id}`);
  console.log(`session:    ${payload.session_url}`);
  if (payload.spawn_id) {
    console.log(`spawn id:   ${payload.spawn_id}`);
  }
  if (payload.warning) {
    console.log(`warning:    ${payload.warning}`);
  }
  console.log(`context:    ${options.contextFile}`);
}

module.exports = {
  attachToLiveSession,
  buildDirectLiveSession,
  buildContext,
  buildUnattachedSession,
  cleanupSpawnedSessions,
  createCliEnv,
  extractSpawnSessionMarker,
  isAgentAuthSessionListUnavailable,
  isCliAgentMode,
  mergeCleanupResults,
  parseArgs,
  resolveSpawnedLiveSession,
  selectLiveSession,
  shouldUseUnattachedAutoFallback,
  shouldDestroySpawnedRow,
  unwrapCliJsonPayload,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt attach error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
