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
    account_id: string;
    auth_session_hash?: string | null;
    name: string;
    args: any[];
    timeout: number;
  }) => Promise<unknown>;
  debug?: (event: string, data: Record<string, unknown>) => void;
}): Promise<T> {
  const timeoutMs = timeout ?? ctx.timeoutMs;
  const rpcTimeoutMs = Math.max(1_000, Math.min(timeoutMs, ctx.rpcTimeoutMs));
  debug?.("hubCallAccount", {
    name,
    timeoutMs,
    rpcTimeoutMs,
    account_id: ctx.accountId,
  });

  return (await withTimeout(
    callHub({
      client: ctx.remote.client,
      account_id: ctx.accountId,
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
  "agent",
  "lro",
  "ssh",
  "reflect",
];

export function createHubApiForContext(
  callByName: <T>(name: string, args?: any[]) => Promise<T>,
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
            await callByName(`${group}.${property}`, args);
        },
      },
    );
  }
  return hub as unknown as HubApi;
}
