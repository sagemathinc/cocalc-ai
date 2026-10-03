/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const RATE_LIMIT_META = "_claude/rateLimit";

/**
 * Split Claude's subscription limits off an ACP update. They are private to
 * the credential's owner, so they are reported, not persisted in the chat.
 */
export function takeRateLimit(update: object): {
  update: object;
  rateLimit?: unknown;
} {
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || !(RATE_LIMIT_META in meta))
    return { update };
  const { [RATE_LIMIT_META]: rateLimit, ...rest } = meta as Record<
    string,
    unknown
  >;
  return { update: { ...update, _meta: rest }, rateLimit };
}
