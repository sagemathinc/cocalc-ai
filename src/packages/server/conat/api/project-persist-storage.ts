/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's edit history and logs (conat/project/persist-storage.ts): any
collaborator sees what they take; deleting or trimming them is a destructive
storage action, for owners only unless an owner allows collaborators (the
project's "Storage history" setting), with a fresh sign-in, as for snapshots.
*/

import {
  MAX_PERSIST_STORAGE_ACTIONS,
  type PersistStorageAction,
  type PersistStorageApplyResult,
  type PersistStorageList,
} from "@cocalc/conat/project/persist-storage";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { assertCanPerformDestructiveStorageAction } from "@cocalc/server/projects/destructive-storage-actions";
import { assertCollab } from "./util";
import { requireDangerousProjectMutationAuth } from "./project-dangerous-auth";

const ACTION = "delete or trim edit history and logs";

function validActions(actions: unknown): PersistStorageAction[] {
  if (!Array.isArray(actions)) {
    throw new Error("actions must be a list");
  }
  if (actions.length > MAX_PERSIST_STORAGE_ACTIONS) {
    throw new Error(`at most ${MAX_PERSIST_STORAGE_ACTIONS} actions at once`);
  }
  return actions.map((action) => {
    const { op, name } = action ?? {};
    if (typeof name !== "string" || !name) {
      throw new Error("each action needs the name of a stream");
    }
    if (op === "delete") return { op, name };
    if (op === "trim") {
      const { before, archived } = action;
      if (before != null && !Number.isFinite(before)) {
        throw new Error("trim: before must be a time in ms");
      }
      if (archived != null && typeof archived !== "boolean") {
        throw new Error("trim: archived must be a boolean");
      }
      return {
        op,
        name,
        ...(before != null ? { before } : {}),
        ...(archived ? { archived } : {}),
      };
    }
    throw new Error(`unknown operation: ${op}`);
  });
}

export async function listProjectPersistStorage({
  account_id,
  project_id,
  limit,
  timeout,
}: {
  account_id?: string;
  project_id: string;
  limit?: number;
  timeout?: number;
}): Promise<PersistStorageList> {
  await assertCollab({ account_id, project_id });
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    timeout,
  });
  const list = await client.persistStorageList({
    project_id,
    ...(limit != null ? { limit } : {}),
  });
  let can_manage = false;
  try {
    await assertCanPerformDestructiveStorageAction({
      account_id,
      project_id,
      action: ACTION,
    });
    can_manage = true;
  } catch {}
  return { ...list, can_manage };
}

export async function applyProjectPersistStorage({
  account_id,
  browser_id,
  session_hash,
  project_id,
  actions,
  timeout,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  actions: PersistStorageAction[];
  timeout?: number;
}): Promise<PersistStorageApplyResult> {
  const valid = validActions(actions);
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });
  await assertCanPerformDestructiveStorageAction({
    account_id,
    project_id,
    action: ACTION,
  });
  if (valid.length === 0) return { results: [], freed: 0 };
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    // while the project's streams are closed, a large trim compacts
    timeout: timeout ?? 15 * 60_000,
  });
  return await client.persistStorageApply({ project_id, actions: valid });
}
