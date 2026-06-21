/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  AiSessionInterruptAllOptions,
  AiSessionInterruptAllResponse,
  AiSessionInterruptOptions,
  AiSessionInterruptResponse,
  AiSessionRecord,
  AiSessionsAdminListOptions,
  AiSessionsListOptions,
} from "@cocalc/conat/hub/api/ai-sessions";
import {
  interruptAiSessionForAdmin,
  interruptAiSessionForAccount,
  interruptAllAiSessionsForAdmin,
  interruptAllAiSessionsForAccount,
  listAiSessionsForAdmin,
  listAiSessionsForAccount,
  upsertProjectHostAiSession,
} from "@cocalc/server/ai/acp-sessions";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

async function requireAdminAccount(
  account_id: string | undefined,
): Promise<string> {
  const actor = `${account_id ?? ""}`.trim();
  if (!actor) {
    throw Error("user must be signed in");
  }
  if (!(await isAdmin(actor))) {
    throw Error("admin privileges required");
  }
  return actor;
}

export async function upsertProjectHostSession({
  authenticated_host_id,
  authenticated_project_id,
  ...record
}: AiSessionRecord & {
  authenticated_host_id?: string;
  authenticated_project_id?: string;
  authenticated_account_id?: string;
}): Promise<void> {
  await upsertProjectHostAiSession({
    record,
    authenticated_host_id,
    authenticated_project_id,
  });
}

export async function list({
  account_id,
  ...opts
}: AiSessionsListOptions = {}): Promise<AiSessionRecord[]> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await listAiSessionsForAccount({ account_id, opts });
}

export async function interrupt({
  account_id,
  ...opts
}: AiSessionInterruptOptions = {}): Promise<AiSessionInterruptResponse> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await interruptAiSessionForAccount({ account_id, ...opts });
}

export async function interruptAll({
  account_id,
  ...opts
}: AiSessionInterruptAllOptions = {}): Promise<AiSessionInterruptAllResponse> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await interruptAllAiSessionsForAccount({ account_id, ...opts });
}

export async function adminList({
  account_id,
  ...opts
}: AiSessionsAdminListOptions = {}): Promise<AiSessionRecord[]> {
  await requireAdminAccount(account_id);
  return await listAiSessionsForAdmin({ opts });
}

export async function adminInterrupt({
  account_id,
  session_hash,
  ...opts
}: AiSessionInterruptOptions & {
  session_hash?: string;
} = {}): Promise<AiSessionInterruptResponse> {
  const actor = await requireAdminAccount(account_id);
  await requireDangerousSessionAuth({
    account_id: actor,
    session_hash,
  });
  return await interruptAiSessionForAdmin({
    actor_account_id: actor,
    ...opts,
  });
}

export async function adminInterruptAll({
  account_id,
  session_hash,
  ...opts
}: AiSessionsAdminListOptions & {
  session_hash?: string;
  note?: string;
} = {}): Promise<AiSessionInterruptAllResponse> {
  const actor = await requireAdminAccount(account_id);
  await requireDangerousSessionAuth({
    account_id: actor,
    session_hash,
  });
  return await interruptAllAiSessionsForAdmin({
    actor_account_id: actor,
    ...opts,
  });
}
