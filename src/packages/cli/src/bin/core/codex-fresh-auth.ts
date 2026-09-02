/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HubApi } from "@cocalc/conat/hub/api";

type AgentContext = {
  accountId: string;
  pollMs: number;
  remote: {
    user?: Record<string, unknown> | null;
  };
  hub: HubApi;
};

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  description: string,
): string {
  const value = `${env[name] ?? ""}`.trim();
  if (!value) {
    throw new Error(`Codex fresh-auth approval requires ${description}`);
  }
  return value;
}

export function isManagedCodexAgentContext(ctx: AgentContext): boolean {
  return ctx.remote.user?.auth_actor === "agent";
}

export async function requestManagedCodexFreshAuth({
  ctx,
  commandName,
  env = process.env,
  write = (message) => process.stderr.write(message),
}: {
  ctx: AgentContext;
  commandName: string;
  env?: NodeJS.ProcessEnv;
  write?: (message: string) => unknown;
}): Promise<void> {
  if (!isManagedCodexAgentContext(ctx)) {
    throw new Error("managed Codex agent authentication is required");
  }
  const authenticatedProjectId = `${
    ctx.remote.user?.auth_project_id ?? ctx.remote.user?.project_id ?? ""
  }`.trim();
  const project_id = requiredEnv(env, "COCALC_PROJECT_ID", "a project id");
  if (!authenticatedProjectId || authenticatedProjectId !== project_id) {
    throw new Error(
      "Codex fresh-auth project context does not match agent auth",
    );
  }
  const browser_id = requiredEnv(
    env,
    "COCALC_BROWSER_ID",
    "an active CoCalc browser session",
  );
  const path = requiredEnv(
    env,
    "COCALC_CODEX_CHAT_PATH",
    "an active CoCalc chat path",
  );
  const thread_id = requiredEnv(
    env,
    "COCALC_CODEX_THREAD_ID",
    "an active CoCalc chat thread",
  );
  const turn_id = `${env.COCALC_CODEX_TURN_ID ?? ""}`.trim();
  const message_date = `${env.COCALC_CODEX_MESSAGE_DATE ?? ""}`.trim();
  const started = await ctx.hub.notifications.startCodexFreshAuthAction({
    source_project_id: project_id,
    browser_id,
    duration: "default",
    context: {
      project_id,
      path,
      thread_id,
      purpose: `${commandName ?? "CoCalc CLI action"}`.trim().slice(0, 200),
      ...(turn_id ? { turn_id } : {}),
      ...(message_date ? { message_date } : {}),
    },
  });
  write(
    "Approval requested in CoCalc. Waiting for approval; this command will continue automatically.\n",
  );
  const expiresAt = new Date(started.expires_at).valueOf();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Codex fresh-auth approval expired");
  }
  const pollMs = Math.max(250, Math.min(ctx.pollMs || 2_000, 5_000));
  let lastError: unknown;
  while (Date.now() < expiresAt) {
    try {
      const status = await ctx.hub.notifications.getCodexFreshAuthActionStatus({
        source_project_id: project_id,
        challenge_id: started.challenge_id,
      });
      if (status.state === "approved") {
        write("Fresh account authorization approved. Retrying action...\n");
        return;
      }
      if (status.state === "canceled") {
        throw new Error("Codex fresh-auth approval was canceled");
      }
      if (status.state === "expired") {
        throw new Error("Codex fresh-auth approval expired");
      }
      lastError = undefined;
    } catch (err) {
      const message = `${(err as Error)?.message ?? err}`;
      if (/canceled|expired|mismatch|not authorized|not found/i.test(message)) {
        throw err;
      }
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    lastError == null
      ? "Codex fresh-auth approval expired"
      : `Codex fresh-auth approval expired after a status error: ${(lastError as Error)?.message ?? lastError}`,
  );
}
