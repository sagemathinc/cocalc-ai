/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { attentionAcp } from "@cocalc/conat/ai/acp/client";
import type { CodexFreshAuthAttentionContext } from "@cocalc/server/auth/cli-auth";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";

export function codexFreshAuthAttentionEnabled(): boolean {
  return process.env.COCALC_CODEX_ATTENTION_FRESH_AUTH !== "0";
}

export async function registerCodexFreshAuthAttention({
  account_id,
  challenge_id,
  context,
}: {
  account_id: string;
  challenge_id: string;
  context: CodexFreshAuthAttentionContext;
}): Promise<void> {
  if (!codexFreshAuthAttentionEnabled()) {
    throw new Error("Codex fresh-auth attention is disabled");
  }
  await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id: context.project_id,
  });
  const client = await getExplicitProjectRoutedClient({
    project_id: context.project_id,
    account_id,
  });
  const result = await attentionAcp(
    {
      action: "register_action",
      project_id: context.project_id,
      account_id,
      path: context.path,
      thread_id: context.thread_id,
      turn_id: context.turn_id,
      message_date: context.message_date,
      action_kind: "fresh_auth",
      action_reference: challenge_id,
    },
    client,
  );
  if (!result.ok) {
    throw new Error(result.error ?? "failed to register Codex attention");
  }
}
