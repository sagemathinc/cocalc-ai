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
  PERSIST_STORAGE_APPLY_TIMEOUT_MS,
  type PersistStorageAction,
  type PersistStorageApplyResult,
  type PersistStorageList,
} from "@cocalc/conat/project/persist-storage";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { assertCanPerformDestructiveStorageAction } from "@cocalc/server/projects/destructive-storage-actions";
import { assertCollab } from "./util";
import { isWorkspaceProjectRuntime } from "@cocalc/server/launchpad/project-runtime";
import { requireDangerousProjectMutationAuth } from "./project-dangerous-auth";

const ACTION = "delete or trim edit history and logs";

function validActions(actions: unknown): PersistStorageAction[] {
  if (!Array.isArray(actions)) {
    throw new Error("actions must be a list");
  }
  if (actions.length > MAX_PERSIST_STORAGE_ACTIONS) {
    throw new Error(`at most ${MAX_PERSIST_STORAGE_ACTIONS} actions at once`);
  }
  return actions.map((action): PersistStorageAction => {
    const { op, name } = action ?? {};
    if (typeof name !== "string" || !name) {
      throw new Error("each action needs the name of a stream");
    }
    if (op === "delete") {
      return {
        op,
        name,
        ...(action.ifDocumentMissing === true
          ? { ifDocumentMissing: true }
          : {}),
      };
    }
    if (op === "trim") {
      const policy = action.policy;
      if (policy?.kind === "since") {
        if (!Number.isFinite(policy.since)) {
          throw new Error("trim: since must be a time in ms");
        }
        return { op, name, policy: { kind: "since", since: policy.since } };
      }
      if (policy?.kind === "without-archived") {
        return { op, name, policy: { kind: "without-archived" } };
      }
      throw new Error(`trim: unknown policy: ${policy?.kind}`);
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
  let can_manage = false;
  try {
    await assertCanPerformDestructiveStorageAction({
      account_id,
      project_id,
      action: ACTION,
    });
    can_manage = true;
  } catch {}
  if (isWorkspaceProjectRuntime()) {
    // a trusted workspace keeps its history with its files
    return {
      supported: false,
      streams: [],
      total: { count: 0, bytes: 0 },
      by_kind: {},
      can_manage,
    };
  }
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    timeout,
  });
  const list = await client.persistStorageList({
    project_id,
    ...(limit != null ? { limit } : {}),
  });
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
  if (isWorkspaceProjectRuntime()) {
    throw new Error(
      "a trusted workspace keeps its edit history with its files; manage it there",
    );
  }
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    // a large trim compacts; a minute less than the client waits, so this
    // answers first
    timeout: Math.max(
      60_000,
      (timeout ?? PERSIST_STORAGE_APPLY_TIMEOUT_MS) - 60_000,
    ),
  });
  return await client.persistStorageApply({ project_id, actions: valid });
}
