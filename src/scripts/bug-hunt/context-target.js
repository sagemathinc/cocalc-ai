#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function run(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
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

function createCliEnv(context) {
  return { ...process.env, ...(context.exports ?? {}) };
}

function runCliJson(context, args) {
  const cliBin = `${context.cli_bin ?? ""}`.trim();
  if (!cliBin) {
    throw new Error("context does not include cli_bin");
  }
  const result = run(process.execPath, [cliBin, "--json", ...args], {
    env: createCliEnv(context),
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

function selectLiveSessionForContext(context, sessions) {
  const rows = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (!rows.length) return undefined;
  const currentBrowserId = `${context.browser_id ?? ""}`.trim();
  if (currentBrowserId) {
    const current = rows.find(
      (session) => `${session?.browser_id ?? ""}`.trim() === currentBrowserId,
    );
    if (current) return current;
  }
  const currentSessionUrl = `${context.session_url ?? ""}`.trim();
  if (currentSessionUrl) {
    const byUrl = rows.find(
      (session) => `${session?.url ?? ""}`.trim() === currentSessionUrl,
    );
    if (byUrl) return byUrl;
  }
  const sessionName = `${context.session_name ?? ""}`.trim();
  if (sessionName) {
    const byName = rows.find(
      (session) => `${session?.session_name ?? ""}`.trim() === sessionName,
    );
    if (byName) return byName;
  }
  const projectId =
    `${context.project_id ?? context.exports?.COCALC_PROJECT_ID ?? ""}`.trim();
  if (projectId) {
    const matchingProject = pickMostRecentSession(
      rows.filter((session) => session.active_project_id === projectId),
    );
    if (matchingProject) return matchingProject;
  }
  return pickMostRecentSession(rows);
}

function refreshLiveContextTargetFromSessions(context, sessions) {
  if (`${context?.browser_mode ?? ""}`.trim() !== "live") {
    return context;
  }
  const selected = selectLiveSessionForContext(context, sessions);
  if (!selected) {
    return context;
  }
  const browserId = `${selected.browser_id ?? context.browser_id ?? ""}`.trim();
  const projectId = `${
    selected.active_project_id ??
    context.project_id ??
    context.exports?.COCALC_PROJECT_ID ??
    ""
  }`.trim();
  return {
    ...context,
    browser_id: browserId,
    project_id: projectId,
    session_url: selected.url ?? context.session_url ?? "",
    session_name: selected.session_name ?? context.session_name ?? "",
    exports: {
      ...(context.exports ?? {}),
      COCALC_BROWSER_ID: browserId,
      COCALC_PROJECT_ID: projectId,
    },
  };
}

function refreshLiveContextTarget(context) {
  if (`${context?.browser_mode ?? ""}`.trim() !== "live") {
    return context;
  }
  const projectId =
    `${context.project_id ?? context.exports?.COCALC_PROJECT_ID ?? ""}`.trim();
  const args = ["browser", "session", "list", "--active-only"];
  if (projectId) {
    args.push("--project-id", projectId);
  }
  const sessions = runCliJson(context, args);
  return refreshLiveContextTargetFromSessions(context, sessions);
}

function writeContextFileIfChanged(contextFile, original, updated) {
  const before = JSON.stringify(original);
  const after = JSON.stringify(updated);
  if (before === after) return false;
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  fs.writeFileSync(contextFile, `${JSON.stringify(updated, null, 2)}\n`);
  return true;
}

module.exports = {
  refreshLiveContextTarget,
  refreshLiveContextTargetFromSessions,
  selectLiveSessionForContext,
  writeContextFileIfChanged,
};
