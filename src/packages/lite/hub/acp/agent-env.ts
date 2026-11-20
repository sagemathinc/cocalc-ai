/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { agentBaseEnv } from "@cocalc/ai/acp";

export { agentBaseEnv };

/**
 * A Codex app-server's environment: agentBaseEnv, then `extra` (the turn's
 * runtime environment, which already carries the CLI's endpoint and scoped
 * token and the conversation's context, see buildCodexRuntimeEnv), then its
 * CODEX_HOME. OPENAI_API_KEY is never inherited: each app-server gets its own
 * explicit login.
 */
export function codexAppServerEnv({
  base = process.env,
  extra,
  codexHome,
}: {
  base?: NodeJS.ProcessEnv;
  extra?: NodeJS.ProcessEnv;
  codexHome: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...agentBaseEnv(base),
    ...extra,
    CODEX_HOME: codexHome,
    COCALC_CODEX_HOME: codexHome,
  };
  delete env.OPENAI_API_KEY;
  if (base.COCALC_ORIGINAL_HOME) env.HOME = base.COCALC_ORIGINAL_HOME;
  return env;
}
