/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  openWorkspaceStore,
  readWorkspaceRecordsFromStore,
  resolveWorkspaceForPath,
  sanitizeWorkspaceAccountId,
  updateWorkspaceRecords,
  writeWorkspaceRecordsToStore,
  type WorkspaceRecord,
} from "@cocalc/conat/workspaces";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { path_split } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { getProjectHomeDirectory } from "../home-directory";

function isMacLikeClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = `${navigator.platform ?? ""}`.toLowerCase();
  return platform.includes("mac");
}

function workspaceChatRelativePath(
  account_id: string,
  workspace_id: string,
): string {
  const base =
    lite && isMacLikeClient()
      ? "Library/Application Support/cocalc"
      : ".local/share/cocalc";
  return `${base}/workspaces/${sanitizeWorkspaceAccountId(account_id)}/${workspace_id}.chat`;
}

export function defaultWorkspaceChatPath(opts: {
  project_id: string;
  account_id: string;
  workspace_id: string;
}): string {
  return normalizeAbsolutePath(
    workspaceChatRelativePath(opts.account_id, opts.workspace_id),
    getProjectHomeDirectory(opts.project_id),
  );
}

export async function readStoredWorkspaceRecords(opts: {
  project_id: string;
  account_id: string;
}): Promise<WorkspaceRecord[]> {
  const store = await openWorkspaceStore({
    client: webapp_client.conat_client,
    account_id: opts.account_id,
    project_id: opts.project_id,
  });
  try {
    return readWorkspaceRecordsFromStore(store);
  } finally {
    store.close();
  }
}

export async function resolveStoredWorkspaceForPath(opts: {
  project_id: string;
  account_id: string;
  path: string;
}): Promise<WorkspaceRecord | null> {
  const absolutePath = normalizeAbsolutePath(
    opts.path,
    getProjectHomeDirectory(opts.project_id),
  );
  const records = await readStoredWorkspaceRecords(opts);
  return resolveWorkspaceForPath(records, absolutePath);
}

export async function ensureWorkspaceChatPath(opts: {
  project_id: string;
  account_id: string;
  workspace_id: string;
}): Promise<{
  workspace: WorkspaceRecord;
  chat_path: string;
  assigned: boolean;
}> {
  const store = await openWorkspaceStore({
    client: webapp_client.conat_client,
    account_id: opts.account_id,
    project_id: opts.project_id,
  });
  try {
    const records = readWorkspaceRecordsFromStore(store);
    const current = records.find(
      (record) => record.workspace_id === opts.workspace_id,
    );
    if (!current) {
      throw new Error(`workspace '${opts.workspace_id}' not found`);
    }
    const existing = `${current.chat_path ?? ""}`.trim();
    const chat_path =
      existing ||
      defaultWorkspaceChatPath({
        project_id: opts.project_id,
        account_id: opts.account_id,
        workspace_id: opts.workspace_id,
      });
    if (existing === chat_path) {
      return { workspace: current, chat_path, assigned: false };
    }
    const { records: nextRecords, updated } = updateWorkspaceRecords(
      records,
      opts.workspace_id,
      { chat_path },
    );
    writeWorkspaceRecordsToStore(store, nextRecords);
    return {
      workspace: updated ?? { ...current, chat_path },
      chat_path,
      assigned: true,
    };
  } finally {
    store.close();
  }
}

export async function ensureWorkspaceChatForPath(opts: {
  project_id: string;
  account_id: string;
  path: string;
}): Promise<{
  workspace: WorkspaceRecord;
  chat_path: string;
  assigned: boolean;
} | null> {
  const workspace = await resolveStoredWorkspaceForPath(opts);
  if (!workspace) return null;
  return await ensureWorkspaceChatPath({
    project_id: opts.project_id,
    account_id: opts.account_id,
    workspace_id: workspace.workspace_id,
  });
}

export async function ensureWorkspaceChatDirectory(opts: {
  project_id: string;
  chat_path: string;
}): Promise<void> {
  const fs = webapp_client.conat_client.conat().fs({
    project_id: opts.project_id,
  });
  try {
    await fs.mkdir(path_split(opts.chat_path).head, { recursive: true });
  } catch {
    // best effort only
  }
}
