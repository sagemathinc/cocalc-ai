/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A project-scoped agent credential gets reply inboxes of its own instead of
// sharing its account's _INBOX.account-<id>, which would let the agent receive
// replies meant for the human (e.g., hub responses about other projects).
//
// The prefix is advertised as auth_api_key_reply_prefix in the connection's
// user info, which clients already honor (see inboxPrefix in ../names), and
// is derived from the credential, so it stays the same when that credential
// is revalidated: a changing prefix would replace the client's inbox and
// interrupt requests in flight.  Each connection takes it from its own
// server, so the inbox is subscribed on the connection that makes the
// requests.

import { createHash } from "crypto";

export function agentReplyPrefix(credentialId: string): string {
  if (!credentialId) {
    throw new Error("agent credential id is required");
  }
  const h = createHash("sha256")
    .update("cocalc-agent-reply-prefix\0")
    .update(credentialId)
    .digest("hex");
  // shaped like an API key's prefix, so existing clients accept it
  return `_INBOX.api-key-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
