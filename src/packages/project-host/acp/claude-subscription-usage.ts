/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import {
  claudeRateLimitSnapshot,
  type ClaudeRateLimitSnapshot,
} from "@cocalc/util/ai/claude-usage";
import { isValidUUID } from "@cocalc/util/misc";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:acp:claude-subscription-usage");
// Claude reports limits with each model response; save at most this often.
const MIN_INTERVAL_MS = 30_000;

type Write = (options: {
  projectId: string;
  accountId: string;
  credentialId: string;
  usage: ClaudeRateLimitSnapshot;
}) => Promise<void>;

type Entry = {
  projectId: string;
  accountId: string;
  credentialId: string;
  latest?: ClaudeRateLimitSnapshot;
  lastWrite: number;
  timer?: ReturnType<typeof setTimeout>;
};

const writeToHomeBay: Write = async ({
  projectId,
  accountId,
  credentialId,
  usage,
}) => {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) return;
  await callHub({
    client,
    host_id,
    name: "hosts.recordClaudeSubscriptionUsage",
    // The hub reserves account_id for the caller; name the owner explicitly.
    args: [
      {
        project_id: projectId,
        owner_account_id: accountId,
        credential_id: credentialId,
        usage,
      },
    ],
    timeout: 15_000,
  });
};

/**
 * Save the subscription limits reported during a turn to the credential's
 * metadata, so any CoCalc page can show them without asking Claude.
 */
export function createClaudeUsageRecorder({
  write = writeToHomeBay,
  minIntervalMs = MIN_INTERVAL_MS,
}: { write?: Write; minIntervalMs?: number } = {}) {
  // An entry outlives its last save by one interval, which spaces out saves,
  // and is then dropped: a long-lived host serves any number of accounts.
  const entries = new Map<string, Entry>();
  const flush = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entry.timer = undefined;
    const usage = entry.latest;
    entry.latest = undefined;
    if (!usage) {
      entries.delete(key);
      return;
    }
    entry.lastWrite = Date.now();
    void write({ ...entry, usage }).catch((error) =>
      logger.debug("Claude usage was not saved", { error: `${error}` }),
    );
    entry.timer = setTimeout(() => flush(key), minIntervalMs);
    entry.timer.unref?.();
  };
  const recordUsage = (options: {
    projectId: string;
    accountId: string;
    credentialId: string;
    info: unknown;
  }): void => {
    const { projectId, accountId, credentialId } = options;
    if (
      !isValidUUID(projectId) ||
      !isValidUUID(accountId) ||
      !isValidUUID(credentialId)
    )
      return;
    const latest = claudeRateLimitSnapshot(options.info);
    if (!latest) return;
    const key = `${accountId}/${credentialId}`;
    const entry = entries.get(key) ?? {
      projectId,
      accountId,
      credentialId,
      lastWrite: 0,
    };
    entries.set(key, { ...entry, projectId, latest });
    if (entry.timer) return;
    const timer = setTimeout(
      () => flush(key),
      Math.max(0, entry.lastWrite + minIntervalMs - Date.now()),
    );
    timer.unref?.();
    entries.get(key)!.timer = timer;
  };
  return Object.assign(recordUsage, { size: () => entries.size });
}

const record = createClaudeUsageRecorder();

/** Harness rate-limit recorder: subscription turns only. */
export function recordHarnessRateLimit(
  binding: {
    projectId: string;
    accountId: string;
    credential: { mode?: string; provider?: string; credentialId?: string };
  },
  info: unknown,
): void {
  const { credential } = binding;
  if (
    credential.mode !== "account-subscription" ||
    credential.provider !== "anthropic" ||
    !credential.credentialId
  )
    return;
  record({
    projectId: binding.projectId,
    accountId: binding.accountId,
    credentialId: credential.credentialId,
    info,
  });
}
