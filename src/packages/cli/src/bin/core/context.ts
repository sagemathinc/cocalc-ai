import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { HubApi } from "@cocalc/conat/hub/api";

export type HubCallContext = {
  timeoutMs: number;
  rpcTimeoutMs: number;
  accountId: string;
  remote: {
    client: ConatClient;
    user?: {
      auth_session_hash?: string | null;
      project_id?: string | null;
      auth_actor?: "account" | "agent";
      auth_project_id?: string | null;
      auth_token_fingerprint?: string | null;
      auth_iat_s?: number | null;
      auth_exp_s?: number | null;
    } | null;
  };
};

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!(timeoutMs > 0)) {
    return await promise;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function hubCallByName<T>({
  ctx,
  name,
  args = [],
  timeout,
  callHub,
  debug,
}: {
  ctx: HubCallContext;
  name: string;
  args?: any[];
  timeout?: number;
  callHub: (opts: {
    client: ConatClient;
    account_id?: string;
    project_id?: string;
    auth_session_hash?: string | null;
    agent?: {
      account_id: string;
      project_id: string;
      token_fingerprint: string;
      issued_at_s: number;
      expires_at_s: number;
    };
    name: string;
    args: any[];
    timeout: number;
  }) => Promise<unknown>;
  debug?: (event: string, data: Record<string, unknown>) => void;
}): Promise<T> {
  const timeoutMs = timeout ?? ctx.timeoutMs;
  const rpcTimeoutMs =
    timeout == null
      ? Math.max(1_000, Math.min(timeoutMs, ctx.rpcTimeoutMs))
      : Math.max(1_000, timeoutMs);
  const projectId = `${ctx.remote.user?.project_id ?? ""}`.trim();
  const agentProjectId = `${ctx.remote.user?.auth_project_id ?? ""}`.trim();
  const agentFingerprint =
    `${ctx.remote.user?.auth_token_fingerprint ?? ""}`.trim();
  const agentIssuedAt = Number(ctx.remote.user?.auth_iat_s ?? 0);
  const agentExpiresAt = Number(ctx.remote.user?.auth_exp_s ?? 0);
  const agent =
    ctx.remote.user?.auth_actor === "agent" &&
    agentProjectId &&
    agentFingerprint &&
    Number.isFinite(agentIssuedAt) &&
    agentIssuedAt > 0 &&
    Number.isFinite(agentExpiresAt) &&
    agentExpiresAt > agentIssuedAt
      ? {
          account_id: ctx.accountId,
          project_id: agentProjectId,
          token_fingerprint: agentFingerprint,
          issued_at_s: agentIssuedAt,
          expires_at_s: agentExpiresAt,
        }
      : undefined;
  debug?.(projectId ? "hubCallProject" : "hubCallAccount", {
    name,
    timeoutMs,
    rpcTimeoutMs,
    ...(projectId ? { project_id: projectId } : { account_id: ctx.accountId }),
  });

  return (await withTimeout(
    callHub({
      client: ctx.remote.client,
      ...(agent
        ? { agent }
        : projectId
          ? { project_id: projectId }
          : { account_id: ctx.accountId }),
      auth_session_hash:
        typeof ctx.remote.user?.auth_session_hash === "string"
          ? ctx.remote.user.auth_session_hash
          : null,
      name,
      args,
      timeout: rpcTimeoutMs,
    }),
    rpcTimeoutMs,
    `timeout waiting for hub response: ${name} (${rpcTimeoutMs}ms)`,
  )) as T;
}

type HubGroupName = Extract<keyof HubApi, string>;

const HUB_API_GROUPS: HubGroupName[] = [
  "system",
  "projects",
  "db",
  "purchases",
  "sync",
  "org",
  "messages",
  "hosts",
  "software",
  "notifications",
  "adminData",
  "adminDb",
  "adminHost",
  "adminSupport",
  "adminCrashes",
  "agent",
  "aiSessions",
  "lro",
  "ssh",
  "reflect",
  "legacyMigration",
  "compute",
];

export function createHubApiForContext(
  callByName: <T>(name: string, args?: any[], timeout?: number) => Promise<T>,
): HubApi {
  const hub = {} as Record<
    HubGroupName,
    Record<string, (...args: any[]) => Promise<any>>
  >;
  for (const group of HUB_API_GROUPS) {
    hub[group] = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== "string") {
            return undefined;
          }
          return async (...args: any[]) =>
            await callByName(`${group}.${property}`, args, args[0]?.timeout);
        },
      },
    );
  }
  return hub as unknown as HubApi;
}
