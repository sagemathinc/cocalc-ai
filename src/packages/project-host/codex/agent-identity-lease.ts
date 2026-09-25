import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("codex:agent-identity-lease");

// This file is distinct from the general own-project CLI credential. A failed
// identity refresh never substitutes an account/project credential.
export async function createAgentIdentityLease({
  api,
  projectId,
  accountId,
  env,
  hostDir,
}: {
  api: Pick<AgentApi, "issueIdentity" | "endIdentityRun">;
  projectId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  hostDir: string;
}) {
  const path = env?.COCALC_CODEX_CHAT_PATH;
  const thread_id = env?.COCALC_CODEX_THREAD_ID;
  if (!path || !thread_id) return;
  let run_id: string = randomUUID();
  const issue = (requestedRunId: string, recover_expired_run_id?: string) =>
    api.issueIdentity({
      project_id: projectId,
      account_id: accountId,
      path,
      thread_id,
      run_id: requestedRunId,
      ...(recover_expired_run_id ? { recover_expired_run_id } : {}),
    });
  const initial = await issue(run_id);
  if (!initial) return;
  const hostPath = join(hostDir, "identity.json");
  let closed = false;
  let refreshing: Promise<void> | undefined;
  let pendingRecovery:
    | { expiredRunId: string; replacementRunId: string }
    | undefined;
  const write = async (credential: typeof initial) => {
    const temp = join(hostDir, `.identity-${randomUUID()}`);
    try {
      await fs.writeFile(temp, JSON.stringify(credential), { mode: 0o600 });
      await fs.rename(temp, hostPath);
    } finally {
      await fs.rm(temp, { force: true });
    }
  };
  try {
    await write(initial);
  } catch (error) {
    await api
      .endIdentityRun({
        account_id: accountId,
        agent_id: initial.agent_id,
        run_id,
      })
      .catch(() => undefined);
    throw error;
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("identity lease closed"));
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let next;
      try {
        if (pendingRecovery) {
          next = await issue(
            pendingRecovery.replacementRunId,
            pendingRecovery.expiredRunId,
          );
          run_id = pendingRecovery.replacementRunId;
          pendingRecovery = undefined;
        } else {
          next = await issue(run_id);
        }
      } catch (error) {
        if (pendingRecovery) throw error;
        if (!`${error}`.includes("agent_identity_run_expired")) throw error;
        const expiredRunId = run_id;
        const replacementRunId = randomUUID();
        pendingRecovery = { expiredRunId, replacementRunId };
        try {
          next = await issue(replacementRunId, expiredRunId);
          run_id = replacementRunId;
          pendingRecovery = undefined;
        } catch (recoveryError) {
          throw recoveryError;
        }
      }
      if (!next) throw new Error("registered identity unavailable");
      if (!closed) await write(next);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const timer = setInterval(() => {
    if (closed) return;
    void refresh().catch(() =>
      logger.warn("identity renewal failed; existing credential will expire", {
        agent_id: initial.agent_id,
        run_id,
      }),
    );
  }, 3 * 60_000);
  timer.unref();
  return {
    hostPath,
    refresh,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await refreshing?.catch(() => undefined);
      try {
        await api.endIdentityRun({
          account_id: accountId,
          agent_id: initial.agent_id,
          run_id: pendingRecovery?.replacementRunId ?? run_id,
        });
      } catch {
        logger.warn(
          "identity run revocation unconfirmed; credential will expire",
          { agent_id: initial.agent_id, run_id },
        );
      }
      await fs.rm(hostPath, { force: true });
    },
  };
}
