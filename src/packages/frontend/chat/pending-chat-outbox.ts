/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  type BrowserOutboxEntry,
  getBrowserOutbox,
} from "@cocalc/frontend/browser-outbox";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CodexThreadConfig } from "@cocalc/chat";
import type { AcpLoopConfig } from "@cocalc/conat/ai/acp/types";
import type {
  NewThreadAgentOptions,
  NewThreadAppearanceOptions,
} from "./actions";

const CHAT_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_PENDING_LEASE_TTL_MS = 30_000;

export type PendingChatSend = {
  project_id: string;
  path: string;
  account_id?: string;
  sender_id?: string;
  input: string;
  date: string;
  message_id: string;
  thread_id: string;
  reply_thread_id?: string;
  parent_message_id?: string;
  send_mode?: "immediate";
  name?: string;
  threadAgent?: NewThreadAgentOptions;
  threadAppearance?: NewThreadAppearanceOptions;
  acp_loop_config?: AcpLoopConfig;
  acpConfigOverride?: Partial<CodexThreadConfig>;
  shouldMarkNotSent?: boolean;
};

export type PendingChatOutboxEntry = BrowserOutboxEntry<PendingChatSend>;

function pendingChatOutboxId({
  project_id,
  path,
  message_id,
}: {
  project_id: string;
  path: string;
  message_id: string;
}): string {
  return `chat-row:${project_id}:${path}:${message_id}`;
}

function preview(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197)}...`;
}

export async function storePendingChatSend(
  pending: PendingChatSend,
): Promise<PendingChatOutboxEntry | undefined> {
  const outbox = getBrowserOutbox();
  if (!outbox) return undefined;
  return await outbox.put<PendingChatSend>({
    id: pendingChatOutboxId(pending),
    kind: "chat-row",
    op: "chat-row",
    account_id: pending.account_id,
    project_id: pending.project_id,
    path: pending.path,
    operation_id: pending.message_id,
    payload: pending,
    label: pending.path,
    description: "Pending chat message",
    preview: preview(pending.input),
    ttlMs: CHAT_PENDING_TTL_MS,
  });
}

export async function removePendingChatSend(
  pending: Pick<PendingChatSend, "project_id" | "path" | "message_id">,
): Promise<void> {
  const outbox = getBrowserOutbox();
  if (!outbox) return;
  await outbox.remove(pendingChatOutboxId(pending));
}

export async function removePendingChatSendEntry(
  entry: PendingChatOutboxEntry,
): Promise<void> {
  const outbox = getBrowserOutbox();
  if (!outbox) return;
  await outbox.remove(entry.id);
}

export async function listPendingChatSends({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<PendingChatOutboxEntry[]> {
  const outbox = getBrowserOutbox();
  if (!outbox) return [];
  return await outbox.list<PendingChatSend>({
    kind: "chat-row",
    project_id,
    path,
  });
}

export async function claimPendingChatSend(
  entry: PendingChatOutboxEntry,
): Promise<PendingChatOutboxEntry | undefined> {
  const outbox = getBrowserOutbox();
  if (!outbox) return undefined;
  return await outbox.acquireLease<PendingChatSend>({
    id: entry.id,
    owner: `${webapp_client.browser_id ?? "browser"}:${Date.now()}`,
    ttlMs: CHAT_PENDING_LEASE_TTL_MS,
  });
}
