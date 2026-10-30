/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One-click Scan: find .chat files in a project with fd through the
// project-host filesystem (no compute start), changed since this account's
// last scan of that project.

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import { normalizeConversationPath } from "@cocalc/util/people";
import { LANGUAGE_MODEL_PREFIXES } from "@cocalc/util/db-schema/ai-models";

export const SCAN_MAX_RESULTS = 2000;
// Places that hold agent or tool chats, caches and snapshots, not
// conversations between people.
export const SCAN_EXCLUDES = [
  ".snapshots",
  ".trash",
  ".local",
  ".cache",
  "node_modules",
];

export function fdOptions(scannedAt?: number | null, now = Date.now()) {
  const options = [
    "--type",
    "f",
    "--extension",
    "chat",
    "--hidden",
    "--no-ignore",
    "--max-results",
    `${SCAN_MAX_RESULTS}`,
  ];
  for (const exclude of SCAN_EXCLUDES) options.push("--exclude", exclude);
  if (scannedAt != null) {
    // A minute of overlap so edits during the previous scan are not missed.
    const seconds = Math.max(60, Math.ceil((now - scannedAt) / 1000) + 60);
    options.push("--changed-within", `${seconds}s`);
  }
  return options;
}

export function parseFdOutput(home: string, stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const value = line.trim().replace(/^\.\//, "");
    if (!value) continue;
    try {
      paths.add(
        normalizeConversationPath(
          value.startsWith("/") ? value : joinAbsolutePath(home, value),
        ),
      );
    } catch {
      // not a usable .chat path
    }
  }
  return [...paths].sort();
}

export interface ProjectScanResult {
  project_id: string;
  // Conversations between people (AI chats are left out).
  paths: string[];
  // How many AI chats were found and left out.
  skipped: number;
  truncated: boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What marks a chat file as a conversation with AI, not between people: a
// thread configured for an agent (Codex and other ACP agents), or a message
// from a language model (its sender id is the model's name).
export const AI_CHAT_PATTERN = [
  '"agent_kind":"acp"',
  '"acp_config":\\{',
  `"sender_id":"(${LANGUAGE_MODEL_PREFIXES.map(escapeRegex).join("|")})`,
].join("|");

export function ripgrepOptions(): string[] {
  const options = [
    "--files-with-matches",
    "--hidden",
    "--no-ignore",
    "--glob",
    "*.chat",
  ];
  for (const exclude of SCAN_EXCLUDES) options.push("--glob", `!${exclude}`);
  return options;
}

export async function scanProject(
  project_id: string,
  scannedAt?: number | null,
): Promise<ProjectScanResult> {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const output = await project.fs().fd(home, {
    options: fdOptions(scannedAt),
    timeout: 30_000,
    maxSize: 4_000_000,
  });
  if (output.code && !output.stdout?.length) {
    throw Error(Buffer.from(output.stderr ?? "").toString() || "scan failed");
  }
  const found = parseFdOutput(home, Buffer.from(output.stdout).toString());
  const ai =
    found.length === 0 ? new Set<string>() : await aiChats(project, home);
  const paths = found.filter((path) => !ai.has(path));
  return {
    project_id,
    paths,
    skipped: found.length - paths.length,
    truncated: !!output.truncated || found.length >= SCAN_MAX_RESULTS,
  };
}

// The AI chats in the project, searched on its host in one pass. If the
// search fails, the scan fails: an AI chat must not be imported by mistake.
async function aiChats(project, home: string): Promise<Set<string>> {
  const output = await project.fs().ripgrep(home, AI_CHAT_PATTERN, {
    options: ripgrepOptions(),
    timeout: 30_000,
    maxSize: 4_000_000,
  });
  // ripgrep exits 1 when nothing matches.
  if (output.code && output.code !== 1) {
    throw Error(
      Buffer.from(output.stderr ?? "").toString() ||
        "could not check which chats are with AI",
    );
  }
  if (output.truncated) {
    throw Error("too many AI chats to check");
  }
  return new Set(parseFdOutput(home, Buffer.from(output.stdout).toString()));
}

export async function fileModified(
  project_id: string,
  path: string,
): Promise<number | undefined> {
  const stat: any = await redux.getProjectActions(project_id)?.fs().stat(path);
  const mtime = stat?.mtimeMs ?? stat?.mtime;
  const value = mtime instanceof Date ? mtime.valueOf() : Number(mtime);
  return Number.isFinite(value) ? value : undefined;
}

export function titleFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return (
    name
      .replace(/\.chat$/, "")
      .replace(/[-_]+/g, " ")
      .trim() || name
  );
}
