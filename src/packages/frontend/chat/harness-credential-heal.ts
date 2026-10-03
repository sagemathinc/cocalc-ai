/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { preferredClaudeCredential } from "@cocalc/frontend/agents/claude-credential-options";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "./harness-credential-selection";

const CACHE_MS = 60_000;
let cache: { at: number; rows: ExternalCredentialInfo[] } | undefined;

async function anthropicCredentials(fresh: boolean) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows =
    await webapp_client.conat_client.hub.system.listExternalCredentials({
      provider: "anthropic",
      scope: "account",
    });
  cache = { at: Date.now(), rows };
  return rows;
}

/**
 * The thread's Claude credential for a new turn. If its account credential
 * was disconnected (e.g. replaced by a new sign-in), switch the thread to the
 * preferred current one instead of failing the turn. Never switches to the
 * project secret, and never blocks a turn when credentials cannot be listed.
 */
export async function healedHarnessCredential(options: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): Promise<AcpHarnessCredential | undefined> {
  const { accountId, projectId, threadKey } = options;
  const selection = readHarnessCredentialSelection(options);
  if (
    !projectId ||
    !threadKey ||
    (selection?.mode !== "account-subscription" &&
      selection?.mode !== "account-api-key")
  )
    return selection;
  const exists = (rows: ExternalCredentialInfo[]) =>
    rows.some((row) => row.id === selection.credentialId && !row.revoked);
  try {
    if (exists(await anthropicCredentials(false))) return selection;
    // Confirm with a fresh list: it may have been connected just now.
    const rows = await anthropicCredentials(true);
    if (exists(rows)) return selection;
    const next = preferredClaudeCredential(selection, rows);
    if (next.mode === "project-secret") return selection;
    writeHarnessCredentialSelection({
      accountId,
      projectId,
      threadKey,
      credential: next,
    });
    return next;
  } catch {
    return selection;
  }
}
