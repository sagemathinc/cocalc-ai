/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import {
  normalizeCodexFreshAuthAttentionContext,
  startCliElevateChallenge,
} from "@cocalc/server/auth/cli-auth";
import {
  codexFreshAuthAttentionEnabled,
  registerCodexFreshAuthAttention,
} from "@cocalc/server/auth/codex-attention";

export default async function cliElevateStart(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    const account_id = await getAccountId(req);
    const session_hash = getRememberMeHash(req);
    if (!account_id || !session_hash) {
      throw new Error("interactive CLI sign-in is required");
    }
    const { duration, codex_attention_context } = getParams(req);
    const attentionContext = normalizeCodexFreshAuthAttentionContext(
      codex_attention_context,
    );
    if (attentionContext != null && !codexFreshAuthAttentionEnabled()) {
      throw new Error("Codex fresh-auth attention is disabled");
    }
    const started = await startCliElevateChallenge({
      req,
      account_id,
      session_hash,
      duration:
        `${duration ?? ""}`.trim() === "extended" ? "extended" : "default",
      codex_attention_context: attentionContext,
    });
    if (attentionContext != null) {
      await registerCodexFreshAuthAttention({
        account_id,
        challenge_id: started.challenge_id,
        context: attentionContext,
      });
    }
    const response: Record<string, unknown> = {
      ...started,
      attention_registered: attentionContext != null,
    };
    if (attentionContext != null) {
      delete response.approval_url;
    }
    res.json(response);
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem starting CLI elevation challenge.",
    });
  }
}
