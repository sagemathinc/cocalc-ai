/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  AiSessionRecord,
  AiSessionsListOptions,
} from "@cocalc/conat/hub/api/ai-sessions";
import {
  listAiSessionsForAccount,
  upsertProjectHostAiSession,
} from "@cocalc/server/ai/acp-sessions";

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
