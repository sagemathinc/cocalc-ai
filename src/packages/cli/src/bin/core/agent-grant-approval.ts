/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type AgentGrantApprovalDetails = {
  request_id?: string;
  approval_url?: string;
  expires_at?: string;
  project_id?: string;
};

function stringAttr(error: unknown, key: string): string | undefined {
  const value =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isAgentGrantRequiredError(error: unknown): boolean {
  const code = stringAttr(error, "code");
  const message = `${(error as any)?.message ?? error ?? ""}`;
  return (
    code === "agent_grant_required" ||
    message.includes("code='agent_grant_required'")
  );
}

export function agentGrantApprovalDetails(
  error: unknown,
): AgentGrantApprovalDetails | undefined {
  if (!isAgentGrantRequiredError(error)) return undefined;
  const message = `${(error as any)?.message ?? error ?? ""}`;
  const approvalUrl =
    stringAttr(error, "approval_url") ??
    message.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[),.;]+$/, "");
  const requestId =
    stringAttr(error, "request_id") ??
    stringAttr(error, "grant_id") ??
    message.match(/request\s+([0-9a-f-]{36})/i)?.[1];
  return {
    ...(requestId ? { request_id: requestId } : {}),
    ...(approvalUrl ? { approval_url: approvalUrl } : {}),
    ...(stringAttr(error, "expires_at")
      ? { expires_at: stringAttr(error, "expires_at") }
      : {}),
    ...(stringAttr(error, "project_id")
      ? { project_id: stringAttr(error, "project_id") }
      : {}),
  };
}

export async function waitForAgentGrantApproval<T>({
  initialError,
  operation,
  onPending,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  pollMs = 2_000,
}: {
  initialError: unknown;
  operation: () => Promise<T>;
  onPending: (details: AgentGrantApprovalDetails) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}): Promise<T> {
  let error = initialError;
  let announcedRequest = "";
  while (true) {
    const details = agentGrantApprovalDetails(error);
    if (!details) throw error;
    const announcementKey =
      details.request_id ?? details.approval_url ?? "agent-grant-required";
    if (announcementKey !== announcedRequest) {
      announcedRequest = announcementKey;
      onPending(details);
    }
    const expiresAt = details.expires_at
      ? Date.parse(details.expires_at)
      : Number.NaN;
    if (Number.isFinite(expiresAt) && now() >= expiresAt) {
      throw error;
    }
    const waitMs = Number.isFinite(expiresAt)
      ? Math.max(0, Math.min(pollMs, expiresAt - now()))
      : pollMs;
    await sleep(waitMs);
    try {
      return await operation();
    } catch (nextError) {
      error = nextError;
    }
  }
}
