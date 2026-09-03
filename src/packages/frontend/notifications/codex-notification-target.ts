/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import Fragment, { type FragmentId } from "@cocalc/frontend/misc/fragment-id";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function codexNotificationFragment(summary: {
  fragment_id?: unknown;
  notice_type?: unknown;
  thread_id?: unknown;
  attention_id?: unknown;
  message_date?: unknown;
}): FragmentId | undefined {
  const fragment = Fragment.decode(nonEmptyString(summary.fragment_id));
  const noticeType = nonEmptyString(summary.notice_type);
  if (noticeType !== "codex_attention") {
    return fragment;
  }
  const thread = nonEmptyString(summary.thread_id);
  const attention = nonEmptyString(summary.attention_id);
  const messageDate = nonEmptyString(summary.message_date);
  const messageTime = Date.parse(messageDate ?? "");
  const chat =
    fragment?.chat ??
    (Number.isFinite(messageTime) ? `${Math.floor(messageTime)}` : undefined);
  if (!thread && !attention && !chat) {
    return fragment;
  }
  return {
    ...fragment,
    ...(chat ? { chat } : undefined),
    ...(thread ? { thread } : undefined),
    ...(attention ? { attention } : undefined),
  };
}
