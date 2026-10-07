/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-private chat composer drafts live in the account-scoped AKV store
// CHAT_DRAFT_STORE, keyed by conversation. Shared by the browser composer and
// tools (e.g. the CLI) that prefill a draft for the user to edit and send.

export const CHAT_DRAFT_STORE = "chat-composer-drafts-v1";
export const CHAT_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/** Stable negative draft key for a thread's composer. */
export function stableDraftKeyFromThreadKey(threadKey: string): number {
  let hash = 0;
  for (let i = 0; i < threadKey.length; i++) {
    hash = (hash * 33 + threadKey.charCodeAt(i)) | 0;
  }
  // Keep reply/thread draft keys negative and non-zero so they never collide
  // with the global composer bucket `0`.
  const positive = Math.abs(hash) || 1;
  return -positive;
}

export function chatComposerDraftKey({
  project_id,
  path,
  composerDraftKey,
  suffix,
}: {
  project_id: string;
  path: string;
  composerDraftKey: number;
  suffix?: string;
}): string {
  const base = `${project_id}:${path}:${composerDraftKey}`;
  return suffix ? `${base}:${suffix}` : base;
}

export interface ChatComposerDraftPayload {
  version: 1;
  text: string;
  updatedAt: number;
  composing?: boolean;
}

export function chatComposerDraftPayload(
  text: string,
  updatedAt = Date.now(),
): ChatComposerDraftPayload {
  return { version: 1, text, updatedAt, composing: false };
}
